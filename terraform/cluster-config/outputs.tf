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

output "prometheus_endpoint" {
  description = "In-cluster Prometheus endpoint URL"
  value       = "http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090"
}

output "demo_url" {
  description = "Public URL for the load generator UI"
  value       = "https://${var.hostname}"
}

output "grafana_url" {
  description = "Public URL for Grafana dashboards"
  value       = "https://${var.hostname}/grafana"
}
