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
