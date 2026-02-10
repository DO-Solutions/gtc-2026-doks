# GTC 2026 — Disaggregated LLM Inference on DigitalOcean

Booth demo for NVIDIA GTC showcasing disaggregated LLM inference on DigitalOcean using NVIDIA's Dynamo inference platform. Runs Llama 3.1 70B on an 8xH200 GPU node with independently scaling prefill and decode worker pools.

See [CLAUDE.md](CLAUDE.md) for full architecture details, demo flow, and technical conventions.

## Prerequisites

- `doctl`, `kubectl`, `helm`, `terraform`, `docker`, `node`/`npm`, `python3`, `make`, `git`
- DigitalOcean account with GPU access (Solutions team)
- Environment variables configured (see below)

## Environment Setup

```bash
# Source env file before any make commands
source ~/env/gtc.env

# Verify
make check-env
```

## Quick Start

```bash
# Dev environment (3x H100)
make deploy ENV=dev

# Prod environment (1x 8xH200)
make deploy ENV=prod
```

## Key Commands

```bash
make infra-plan ENV=dev    # Preview infrastructure changes
make infra-up ENV=dev      # Create infrastructure
make cluster-config        # Configure cluster (Helm, namespaces, secrets)
make teardown              # Tear everything down
make clean                 # Remove local Terraform state
```

## Project Structure

```
terraform/infra/           # Stack 1: VPC, DOKS, NFS
terraform/cluster-config/  # Stack 2: Helm releases, namespaces, secrets
terraform/environments/    # dev.tfvars, prod.tfvars
k8s/dynamo/                # DGD CRs and TRT-LLM engine configs
k8s/keda/                  # KEDA ScaledObject definitions
apps/load-generator/       # Load gen UI + backend
apps/corpus-curator/       # Document corpus preparation
scripts/                   # Helper scripts
```
