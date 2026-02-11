# GTC 2026 Disaggregated Inference Demo
# Usage: make <target> ENV=dev|prod

ENV       ?= dev
REGION    ?= atl1
REGISTRY  := registry.digitalocean.com/do-solutions-sfo3
TAG       := $(shell date +%Y%m%d)-$(shell git rev-parse --short HEAD)

TF_INFRA  := terraform/infra
TF_CLUSTER := terraform/cluster-config
TF_VARS   := -var-file=../environments/$(ENV).tfvars

MODEL     ?= meta-llama/Llama-3.1-8B-Instruct
MODEL_SLUG = $(shell echo '$(subst /,--,$(MODEL))' | tr '[:upper:]' '[:lower:]')
CONTEXT   ?= do-nyc2-gtc-demo

# Pass secrets to Terraform as TF_VAR_* env vars
export TF_VAR_hf_token              := $(HF_TOKEN)
export TF_VAR_spaces_access_key_id  := $(SPACES_ACCESS_KEY_ID)
export TF_VAR_spaces_secret_access_key := $(SPACES_SECRET_ACCESS_KEY)
export TF_VAR_gradient_api_key      := $(GRADIENT_API_KEY)

.PHONY: help check-env \
	infra-init infra-plan infra-up infra-down \
	cluster-config cluster-teardown \
	deploy teardown clean \
	model-to-spaces model-to-nfs setup-model \
	build-loadgen build-all push-loadgen push-all build-push-all \
	deploy-dynamo deploy-keda deploy-loadgen deploy-corpus deploy-apps \
	demo-status demo-start demo-auto demo-stop demo-reset demo-dashboard demo-ui \
	test-inference test-disagg test-kv-cache test-scaling validate-all

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# --- Environment ---

check-env: ## Validate required environment variables
	@scripts/check-env.sh

# --- Infrastructure (Stack 1) ---

infra-init: check-env ## Initialize Terraform for infra stack
	terraform -chdir=$(TF_INFRA) init

infra-plan: check-env ## Plan infra changes
	terraform -chdir=$(TF_INFRA) plan $(TF_VARS)

infra-up: check-env ## Apply infra stack + save kubeconfig
	terraform -chdir=$(TF_INFRA) init -input=false
	terraform -chdir=$(TF_INFRA) apply $(TF_VARS) -auto-approve
	doctl kubernetes cluster kubeconfig save gtc-demo --context solutions

infra-down: check-env ## Destroy infra stack
	terraform -chdir=$(TF_INFRA) destroy $(TF_VARS) -auto-approve

# --- Cluster Config (Stack 2) ---

cluster-config: check-env ## Apply cluster config (Helm releases, namespaces, secrets)
	terraform -chdir=$(TF_CLUSTER) init
	terraform -chdir=$(TF_CLUSTER) apply -auto-approve

cluster-teardown: check-env ## Destroy cluster config
	terraform -chdir=$(TF_CLUSTER) destroy -auto-approve

# --- Full Deploy / Teardown ---

deploy: check-env infra-init infra-up cluster-config setup-model build-push-all deploy-apps ## Full deployment chain
	@echo "Deploy complete for ENV=$(ENV)"

teardown: ## Full teardown (reverse order, errors suppressed)
	-$(MAKE) demo-stop
	-$(MAKE) cluster-teardown
	-$(MAKE) infra-down

clean: ## Remove Terraform local state and caches
	rm -rf $(TF_INFRA)/.terraform $(TF_INFRA)/.terraform.lock.hcl $(TF_INFRA)/terraform.tfstate*
	rm -rf $(TF_CLUSTER)/.terraform $(TF_CLUSTER)/.terraform.lock.hcl $(TF_CLUSTER)/terraform.tfstate*

# --- Model Management (TODO) ---

model-to-spaces: check-env ## Download model to Spaces bucket
	kubectl --context $(CONTEXT) delete job model-upload-spaces-$(MODEL_SLUG) -n dynamo-workload --ignore-not-found=true
	MODEL=$(MODEL) MODEL_SLUG=$(MODEL_SLUG) envsubst '$${MODEL} $${MODEL_SLUG}' < k8s/jobs/model-upload-spaces.yaml | kubectl --context $(CONTEXT) apply -f -
	kubectl --context $(CONTEXT) wait --for=condition=complete --timeout=1800s job/model-upload-spaces-$(MODEL_SLUG) -n dynamo-workload

model-to-nfs: check-env ## Copy model from Spaces to NFS
	kubectl --context $(CONTEXT) delete job model-download-nfs-$(MODEL_SLUG) -n dynamo-workload --ignore-not-found=true
	MODEL=$(MODEL) MODEL_SLUG=$(MODEL_SLUG) envsubst '$${MODEL} $${MODEL_SLUG}' < k8s/jobs/model-download-nfs.yaml | kubectl --context $(CONTEXT) apply -f -
	kubectl --context $(CONTEXT) wait --for=condition=complete --timeout=1800s job/model-download-nfs-$(MODEL_SLUG) -n dynamo-workload

setup-model: check-env ## Full model setup (Spaces + NFS)
	MODEL=$(MODEL) scripts/setup-model.sh

# --- Container Images (TODO) ---

build-loadgen: ## Build load generator image
	docker build -t $(REGISTRY)/gtc-demo-loadgen:$(TAG) apps/load-generator

build-all: build-loadgen ## Build all images

push-loadgen: ## Push load generator image
	docker push $(REGISTRY)/gtc-demo-loadgen:$(TAG)

push-all: push-loadgen ## Push all images

build-push-all: build-all push-all ## Build and push all images

# --- Application Deployment (TODO) ---

deploy-dynamo: check-env ## Deploy Dynamo DGD workloads
	kubectl --context $(CONTEXT) apply -f k8s/storage/model-nfs-pvc.yaml
	kubectl --context $(CONTEXT) apply -f k8s/dynamo/$(ENV)-disagg.yaml
	scripts/wait-for-dynamo.sh

deploy-keda: ## Deploy KEDA ScaledObjects
	@echo "TODO: Implement deploy-keda"

deploy-loadgen: ## Deploy load generator
	sed 's|TAG_PLACEHOLDER|$(TAG)|g; s|MODEL_PLACEHOLDER|/models/$(MODEL)|g' \
		apps/load-generator/k8s/deployment.yaml | kubectl --context $(CONTEXT) apply -f -
	kubectl --context $(CONTEXT) apply -f apps/load-generator/k8s/service.yaml

deploy-corpus: check-env ## Curate and upload corpus to Spaces
	pip install -q -r apps/corpus-curator/requirements.txt
	python3 apps/corpus-curator/curate.py

deploy-apps: deploy-dynamo deploy-keda deploy-loadgen deploy-corpus ## Deploy all application workloads

# --- Demo Control (TODO) ---

demo-status: ## Show demo status (pods, scaling, metrics)
	@echo "=== Nodes ==="
	@kubectl --context $(CONTEXT) get nodes -o wide
	@echo ""
	@echo "=== DGD, DGDSA, Pods, PVC (dynamo-workload) ==="
	@kubectl --context $(CONTEXT) get dgd,dgdsa,pods,pvc -n dynamo-workload

demo-start: ## Start demo in manual mode
	@echo "Switching to manual mode and starting balanced workload..."
	@kubectl --context $(CONTEXT) port-forward svc/loadgen 3000:3000 -n dynamo-workload &
	@sleep 2
	@curl -sf -X POST localhost:3000/api/scenario/manual | python3 -m json.tool
	@curl -sf -X POST localhost:3000/api/workload/start \
		-H 'Content-Type: application/json' \
		-d '{"totalRPS":2,"mix":{"a":0.4,"b":0.3,"c":0.3},"maxConcurrency":10}' | python3 -m json.tool
	@kill %1 2>/dev/null || true

demo-auto: ## Start demo in auto mode
	@echo "Starting auto mode..."
	@kubectl --context $(CONTEXT) port-forward svc/loadgen 3000:3000 -n dynamo-workload &
	@sleep 2
	@curl -sf -X POST localhost:3000/api/scenario/auto | python3 -m json.tool
	@kill %1 2>/dev/null || true

demo-stop: ## Stop demo (scale down load)
	@echo "Stopping demo..."
	@kubectl --context $(CONTEXT) port-forward svc/loadgen 3000:3000 -n dynamo-workload &
	@sleep 2
	@-curl -sf -X POST localhost:3000/api/scenario/stop | python3 -m json.tool
	@-curl -sf -X POST localhost:3000/api/workload/stop | python3 -m json.tool
	@kill %1 2>/dev/null || true

demo-reset: ## Reset demo to baseline state
	@echo "TODO: Implement demo-reset"

demo-dashboard: ## Open Grafana dashboard
	@echo "TODO: Implement demo-dashboard"

demo-ui: ## Open load generator UI
	@echo "TODO: Implement demo-ui"

# --- Validation (TODO) ---

test-inference: ## Test basic inference endpoint
	@echo "Finding Dynamo frontend pod..."
	$(eval FRONTEND_POD := $(shell kubectl --context $(CONTEXT) get pods -n dynamo-workload -l nvidia.com/dynamo-graph-deployment-name=gtc-demo,nvidia.com/dynamo-component-type=frontend -o jsonpath='{.items[0].metadata.name}'))
	@if [ -z "$(FRONTEND_POD)" ]; then echo "ERROR: No frontend pod found"; exit 1; fi
	@echo "Port-forwarding to $(FRONTEND_POD)..."
	@kubectl --context $(CONTEXT) port-forward pod/$(FRONTEND_POD) 8000:8000 -n dynamo-workload &
	@sleep 3
	@echo "Sending test request..."
	@curl -s --max-time 60 http://localhost:8000/v1/chat/completions \
		-H "Content-Type: application/json" \
		-d '{"model":"/models/$(MODEL)","messages":[{"role":"user","content":"Say hello in one sentence."}],"max_tokens":50}' | python3 -m json.tool
	@kill %1 2>/dev/null || true

test-disagg: ## Test disaggregated routing
	@echo "TODO: Implement test-disagg"

test-kv-cache: ## Test KV cache hit behavior
	@echo "TODO: Implement test-kv-cache"

test-scaling: ## Test KEDA scaling triggers
	@echo "TODO: Implement test-scaling"

validate-all: test-inference test-disagg test-kv-cache test-scaling ## Run all validation tests
