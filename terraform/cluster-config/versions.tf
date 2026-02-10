terraform {
  required_version = "~> 1"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = ">= 2.72.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2"
    }
  }
}

# Discover Stack 1 outputs via local state file
data "terraform_remote_state" "infra" {
  backend = "local"
  config = {
    path = "../infra/terraform.tfstate"
  }
}

# Fetch live cluster credentials
data "digitalocean_kubernetes_cluster" "gtc" {
  name = data.terraform_remote_state.infra.outputs.cluster_name
}

provider "kubernetes" {
  host  = data.digitalocean_kubernetes_cluster.gtc.endpoint
  token = data.digitalocean_kubernetes_cluster.gtc.kube_config[0].token
  cluster_ca_certificate = base64decode(
    data.digitalocean_kubernetes_cluster.gtc.kube_config[0].cluster_ca_certificate
  )
}

provider "helm" {
  kubernetes {
    host  = data.digitalocean_kubernetes_cluster.gtc.endpoint
    token = data.digitalocean_kubernetes_cluster.gtc.kube_config[0].token
    cluster_ca_certificate = base64decode(
      data.digitalocean_kubernetes_cluster.gtc.kube_config[0].cluster_ca_certificate
    )
  }
}
