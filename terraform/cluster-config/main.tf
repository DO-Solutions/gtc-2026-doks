locals {
  nfs_host       = data.terraform_remote_state.infra.outputs.nfs_host
  nfs_mount_path = data.terraform_remote_state.infra.outputs.nfs_mount_path
  nfs_size_gb    = data.terraform_remote_state.infra.outputs.nfs_size_gb
}

# --- Namespaces ---

resource "kubernetes_namespace_v1" "dynamo_workload" {
  metadata {
    name = "dynamo-workload"
  }
}

resource "kubernetes_namespace_v1" "dynamo_system" {
  metadata {
    name = "dynamo-system"
  }
}

resource "kubernetes_namespace_v1" "monitoring" {
  metadata {
    name = "monitoring"
  }
}

resource "kubernetes_namespace_v1" "keda" {
  metadata {
    name = "keda"
  }
}

# --- RuntimeClass ---

resource "kubernetes_runtime_class_v1" "nvidia" {
  metadata {
    name = "nvidia"
  }
  handler = "nvidia"
}

# --- Secrets ---

resource "kubernetes_secret_v1" "hf_token" {
  metadata {
    name      = "hf-token"
    namespace = kubernetes_namespace_v1.dynamo_workload.metadata[0].name
  }
  data = {
    HF_TOKEN = var.hf_token
  }
}

resource "kubernetes_secret_v1" "spaces_credentials" {
  metadata {
    name      = "spaces-credentials"
    namespace = kubernetes_namespace_v1.dynamo_workload.metadata[0].name
  }
  data = {
    AWS_ACCESS_KEY_ID     = var.spaces_access_key_id
    AWS_SECRET_ACCESS_KEY = var.spaces_secret_access_key
  }
}

resource "kubernetes_secret_v1" "gradient_api_key" {
  metadata {
    name      = "gradient-api-key"
    namespace = kubernetes_namespace_v1.dynamo_workload.metadata[0].name
  }
  data = {
    GRADIENT_API_KEY = var.gradient_api_key
  }
}

# --- NFS PV + PVC ---

resource "kubernetes_persistent_volume_v1" "model_nfs" {
  metadata {
    name = "model-nfs-pv"
    labels = {
      type = "model-nfs"
    }
  }
  spec {
    capacity = {
      storage = "${local.nfs_size_gb}Gi"
    }
    access_modes                     = ["ReadWriteMany"]
    persistent_volume_reclaim_policy = "Retain"
    storage_class_name               = "nfs-static"
    mount_options                    = ["nfsvers=4.1", "nconnect=16"]
    persistent_volume_source {
      nfs {
        server = local.nfs_host
        path   = local.nfs_mount_path
      }
    }
  }
}

# --- GPU Network Tuner DaemonSet ---

resource "kubernetes_daemon_set_v1" "gpu_network_tuner" {
  metadata {
    name      = "gpu-network-tuner"
    namespace = "kube-system"
    labels = {
      app = "gpu-network-tuner"
    }
  }

  spec {
    selector {
      match_labels = {
        app = "gpu-network-tuner"
      }
    }

    template {
      metadata {
        labels = {
          app = "gpu-network-tuner"
        }
      }

      spec {
        host_network = true
        host_pid     = true

        affinity {
          node_affinity {
            required_during_scheduling_ignored_during_execution {
              node_selector_term {
                match_expressions {
                  key      = "doks.digitalocean.com/gpu-brand"
                  operator = "In"
                  values   = ["nvidia"]
                }
              }
            }
          }
        }

        toleration {
          key      = "nvidia.com/gpu"
          operator = "Exists"
          effect   = "NoSchedule"
        }

        init_container {
          name  = "sysctl-tuner"
          image = "busybox:1.36"

          command = ["/bin/sh", "-c"]
          args = [
            <<-EOT
            sysctl -w net.core.rmem_max=16777216 && \
            sysctl -w net.core.wmem_max=16777216 && \
            sysctl -w net.ipv4.tcp_rmem="4096 87380 16777216" && \
            sysctl -w net.ipv4.tcp_wmem="4096 65536 16777216" && \
            ip link set eth1 mtu 9000
            EOT
          ]

          security_context {
            privileged = true
          }
        }

        container {
          name  = "pause"
          image = "busybox:1.36"

          command = ["/bin/sh", "-c", "sleep infinity"]

          resources {
            requests = {
              cpu    = "1m"
              memory = "16Mi"
            }
            limits = {
              cpu    = "10m"
              memory = "16Mi"
            }
          }
        }
      }
    }
  }
}

# --- Helm Releases ---

# 1. Dynamo CRDs
resource "helm_release" "dynamo_crds" {
  name      = "dynamo-crds"
  chart     = "https://helm.ngc.nvidia.com/nvidia/ai-dynamo/charts/dynamo-crds-0.8.1.tgz"
  namespace = "default"
}

# 2. Dynamo Platform (depends on CRDs)
resource "helm_release" "dynamo_platform" {
  name      = "dynamo-platform"
  chart     = "https://helm.ngc.nvidia.com/nvidia/ai-dynamo/charts/dynamo-platform-0.8.1.tgz"
  namespace = kubernetes_namespace_v1.dynamo_system.metadata[0].name

  set {
    name  = "grove.enabled"
    value = "true"
  }

  set {
    name  = "kai-scheduler.enabled"
    value = "true"
  }

  set {
    name  = "prometheusEndpoint"
    value = "http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090"
  }

  # The KAI operator auto-configures scheduling shards and GPU topology
  # from NVIDIA GPU Operator resources, which DOKS doesn't use. We only
  # need the KAI scheduler for gang scheduling, so disable the operator.
  set {
    name  = "kai-scheduler.operator.replicaCount"
    value = "0"
  }

  depends_on = [helm_release.dynamo_crds]
}

# 3. kube-prometheus-stack
resource "helm_release" "kube_prometheus_stack" {
  name       = "kube-prometheus-stack"
  repository = "https://prometheus-community.github.io/helm-charts"
  chart      = "kube-prometheus-stack"
  namespace  = kubernetes_namespace_v1.monitoring.metadata[0].name

  values = [yamlencode({
    prometheus = {
      prometheusSpec = {
        podMonitorSelectorNilUsesHelmValues  = false
        podMonitorNamespaceSelector          = {}
        serviceMonitorSelectorNilUsesHelmValues = false
        serviceMonitorNamespaceSelector      = {}
        probeSelectorNilUsesHelmValues       = false
        probeNamespaceSelector               = {}
      }
    }
    grafana = {
      sidecar = {
        dashboards = {
          enabled = true
          label   = "grafana_dashboard"
        }
      }
    }
  })]

  depends_on = [helm_release.dynamo_platform]
}

# 4. DCGM Exporter (GPU nodes only)
resource "helm_release" "dcgm_exporter" {
  name       = "dcgm-exporter"
  repository = "https://nvidia.github.io/dcgm-exporter/helm-charts"
  chart      = "dcgm-exporter"
  namespace  = kubernetes_namespace_v1.monitoring.metadata[0].name

  values = [yamlencode({
    affinity = {
      nodeAffinity = {
        requiredDuringSchedulingIgnoredDuringExecution = {
          nodeSelectorTerms = [{
            matchExpressions = [{
              key      = "doks.digitalocean.com/gpu-brand"
              operator = "In"
              values   = ["nvidia"]
            }]
          }]
        }
      }
    }
    tolerations = [{
      key      = "nvidia.com/gpu"
      operator = "Exists"
      effect   = "NoSchedule"
    }]
  })]

  depends_on = [helm_release.kube_prometheus_stack]
}

# 5. KEDA
resource "helm_release" "keda" {
  name       = "keda"
  repository = "https://kedacore.github.io/charts"
  chart      = "keda"
  namespace  = kubernetes_namespace_v1.keda.metadata[0].name

  depends_on = [helm_release.kube_prometheus_stack]
}

# --- Grafana Dashboard ConfigMaps ---

resource "kubernetes_config_map_v1" "grafana_dynamo_dashboard" {
  metadata {
    name      = "grafana-dynamo-dashboard"
    namespace = kubernetes_namespace_v1.monitoring.metadata[0].name
    labels = {
      grafana_dashboard = "1"
    }
  }
  data = {
    "dynamo-dashboard.json" = "{}"
  }
}

resource "kubernetes_config_map_v1" "grafana_kvbm_dashboard" {
  metadata {
    name      = "grafana-kvbm-dashboard"
    namespace = kubernetes_namespace_v1.monitoring.metadata[0].name
    labels = {
      grafana_dashboard = "1"
    }
  }
  data = {
    "kvbm-dashboard.json" = "{}"
  }
}

resource "kubernetes_config_map_v1" "grafana_demo_dashboard" {
  metadata {
    name      = "grafana-demo-dashboard"
    namespace = kubernetes_namespace_v1.monitoring.metadata[0].name
    labels = {
      grafana_dashboard = "1"
    }
  }
  data = {
    "demo-dashboard.json" = "{}"
  }
}
