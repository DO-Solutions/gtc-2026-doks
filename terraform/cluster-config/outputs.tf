output "dynamo_workload_namespace" {
  description = "Namespace for Dynamo workloads (DGDs, load generator)"
  value       = kubernetes_namespace_v1.dynamo_workload.metadata[0].name
}

output "dynamo_system_namespace" {
  description = "Namespace for Dynamo platform components"
  value       = kubernetes_namespace_v1.dynamo_system.metadata[0].name
}

output "monitoring_namespace" {
  description = "Namespace for Prometheus, Grafana, and DCGM exporter"
  value       = kubernetes_namespace_v1.monitoring.metadata[0].name
}

output "model_nfs_pvc_name" {
  description = "Name of the PVC for NFS model storage"
  value       = kubernetes_persistent_volume_claim_v1.model_nfs.metadata[0].name
}

output "prometheus_endpoint" {
  description = "In-cluster Prometheus endpoint URL"
  value       = "http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090"
}
