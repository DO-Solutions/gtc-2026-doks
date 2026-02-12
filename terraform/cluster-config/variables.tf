variable "hf_token" {
  type        = string
  sensitive   = true
  description = "Hugging Face API token for model downloads"
}

variable "spaces_access_key_id" {
  type        = string
  sensitive   = true
  description = "DigitalOcean Spaces access key ID"
}

variable "spaces_secret_access_key" {
  type        = string
  sensitive   = true
  description = "DigitalOcean Spaces secret access key"
}

variable "gradient_api_key" {
  type        = string
  sensitive   = true
  description = "Gradient API key for DO Serverless Inference"
}

variable "digitalocean_token" {
  type        = string
  sensitive   = true
  description = "DigitalOcean API token for cert-manager DNS-01 and external-dns"
}

variable "hostname" {
  type        = string
  description = "Public hostname (e.g., gtc-2026-dev.digitalocean.solutions)"
}

variable "letsencrypt_email" {
  type        = string
  default     = "gtc-2026-demo@digitalocean.com"
  description = "Email for Let's Encrypt certificate notifications"
}
