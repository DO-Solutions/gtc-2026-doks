# GTC 2026 Optimized LLM Inference Demo
# Usage: make <target> ENV=dev|prod

ENV       ?= dev
REGION    ?= atl1
REGISTRY  := registry.digitalocean.com/do-solutions-sfo3
TAG       := $(shell date +%Y%m%d)-$(shell git rev-parse --short HEAD)

TF_INFRA  := terraform/infra
TF_CLUSTER := terraform/cluster-config
TF_VARS   := -var-file=../environments/$(ENV).tfvars

MODEL     ?= nvidia/Llama-3.1-70B-Instruct-FP8
MODEL_SLUG = $(shell echo '$(subst /,--,$(MODEL))' | tr '[:upper:]' '[:lower:]')
CONTEXT   ?= do-nyc2-gtc-demo

ifeq ($(ENV),prod)
  HOSTNAME := gtc-2026.digitalocean.solutions
else
  HOSTNAME := gtc-2026-dev.digitalocean.solutions
endif

# Pass secrets to Terraform as TF_VAR_* env vars
export TF_VAR_hf_token              := $(HF_TOKEN)
export TF_VAR_spaces_access_key_id  := $(SPACES_ACCESS_KEY_ID)
export TF_VAR_spaces_secret_access_key := $(SPACES_SECRET_ACCESS_KEY)
export TF_VAR_gradient_api_key      := $(GRADIENT_API_KEY)
export TF_VAR_digitalocean_token    := $(DIGITALOCEAN_TOKEN)

.PHONY: help check-env \
	infra-init infra-plan infra-up infra-down \
	cluster-config cluster-teardown \
	deploy teardown clean \
	model-to-spaces model-to-nfs setup-model \
	build-loadgen build-all push-loadgen push-all build-push-all \
	deploy-dynamo deploy-dynamo-vllm deploy-loadgen deploy-corpus deploy-apps \
	deploy-gateway test-gateway \
	demo-status demo-start demo-auto demo-stop demo-reset demo-dashboard demo-ui \
	test-inference test-kv-cache validate-all \
	capacity-test benchmark-sweep collect-conversations phase1-sweep

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

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
	terraform -chdir=$(TF_CLUSTER) apply $(TF_VARS) -auto-approve

cluster-teardown: check-env ## Destroy cluster config
	terraform -chdir=$(TF_CLUSTER) destroy $(TF_VARS) -auto-approve

# --- Full Deploy / Teardown ---

ensure-pvc: ## Ensure model NFS PVC exists (needed before setup-model)
	kubectl --context $(CONTEXT) apply -f k8s/storage/model-nfs-pvc.yaml

deploy: check-env infra-init infra-up cluster-config ensure-pvc setup-model build-push-all deploy-apps ## Full deployment chain
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
	kubectl --context $(CONTEXT) apply -f k8s/dynamo/rbac-k8s-discovery-fix.yaml
	kubectl --context $(CONTEXT) apply -f k8s/dynamo/worker-podmonitor.yaml
	kubectl --context $(CONTEXT) apply -f k8s/dynamo/frontend-podmonitor.yaml
	$(eval WORKERS ?= $(shell kubectl --context $(CONTEXT) get nodes -l doks.digitalocean.com/gpu-brand=nvidia --no-headers 2>/dev/null | grep -c " Ready" || echo 0))
	@if [ "$(WORKERS)" = "0" ]; then echo "ERROR: No Ready GPU nodes found"; exit 1; fi
	@echo "Deploying DGD with $(WORKERS) worker replicas (from GPU node count)"
	sed 's|REPLICAS_PLACEHOLDER|$(WORKERS)|g' \
		k8s/dynamo/$(ENV)-agg.yaml | kubectl --context $(CONTEXT) apply -f -
	KUBE_CONTEXT=$(CONTEXT) scripts/wait-for-dynamo.sh

deploy-dynamo-vllm: check-env ## Deploy vLLM DGD workloads (replaces existing DGD)
	kubectl --context $(CONTEXT) apply -f k8s/storage/model-nfs-pvc.yaml
	kubectl --context $(CONTEXT) apply -f k8s/dynamo/rbac-k8s-discovery-fix.yaml
	kubectl --context $(CONTEXT) apply -f k8s/dynamo/worker-podmonitor.yaml
	kubectl --context $(CONTEXT) apply -f k8s/dynamo/frontend-podmonitor.yaml
	@echo "Deleting existing DGD (switching backend requires replace)..."
	-kubectl --context $(CONTEXT) delete dgd gtc-demo -n dynamo-workload --ignore-not-found=true
	@echo "Waiting for old pods to terminate..."
	-kubectl --context $(CONTEXT) wait --for=delete pods -l nvidia.com/dynamo-graph-deployment-name=gtc-demo -n dynamo-workload --timeout=120s 2>/dev/null || true
	$(eval WORKERS ?= $(shell kubectl --context $(CONTEXT) get nodes -l doks.digitalocean.com/gpu-brand=nvidia --no-headers 2>/dev/null | grep -c " Ready" || echo 0))
	@if [ "$(WORKERS)" = "0" ]; then echo "ERROR: No Ready GPU nodes found"; exit 1; fi
	@echo "Deploying vLLM DGD with $(WORKERS) worker replicas (from GPU node count)"
	sed 's|REPLICAS_PLACEHOLDER|$(WORKERS)|g' \
		k8s/dynamo/$(ENV)-agg-vllm.yaml | kubectl --context $(CONTEXT) apply -f -
	KUBE_CONTEXT=$(CONTEXT) scripts/wait-for-dynamo.sh

deploy-loadgen: ## Deploy load generator
	sed 's|TAG_PLACEHOLDER|$(TAG)|g; s|MODEL_PLACEHOLDER|/models/$(MODEL)|g' \
		apps/load-generator/k8s/deployment.yaml | kubectl --context $(CONTEXT) apply -f -
	kubectl --context $(CONTEXT) apply -f apps/load-generator/k8s/service.yaml
	kubectl --context $(CONTEXT) apply -f apps/load-generator/k8s/servicemonitor.yaml

deploy-corpus: check-env ## Curate and upload corpus to Spaces
	pip install -q -r apps/corpus-curator/requirements.txt
	python3 apps/corpus-curator/curate.py

deploy-gateway: check-env ## Deploy Gateway API resources (cert-issuer, gateway, routes)
	kubectl --context $(CONTEXT) apply -f k8s/gateway/clusterissuer-letsencrypt.yaml
	sed 's|HOSTNAME_PLACEHOLDER|$(HOSTNAME)|g' \
		k8s/gateway/gateway.yaml | kubectl --context $(CONTEXT) apply -f -
	sed 's|HOSTNAME_PLACEHOLDER|$(HOSTNAME)|g' \
		k8s/gateway/httproute-loadgen.yaml | kubectl --context $(CONTEXT) apply -f -
	sed 's|HOSTNAME_PLACEHOLDER|$(HOSTNAME)|g' \
		k8s/gateway/httproute-grafana.yaml | kubectl --context $(CONTEXT) apply -f -
	sed 's|HOSTNAME_PLACEHOLDER|$(HOSTNAME)|g' \
		k8s/gateway/httproute-http-redirect.yaml | kubectl --context $(CONTEXT) apply -f -

deploy-apps: deploy-dynamo deploy-loadgen deploy-corpus deploy-gateway ## Deploy all application workloads

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
		-d '{"totalRPS":10,"mix":{"a":1.0,"b":0,"c":0},"maxConcurrency":35}' | python3 -m json.tool
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

grafana-password: ## Print Grafana admin password
	@kubectl --context $(CONTEXT) get secret kube-prometheus-stack-grafana -n monitoring -o jsonpath='{.data.admin-password}' | base64 -d && echo

demo-dashboard: ## Port-forward Grafana (http://localhost:3001)
	@echo "Grafana available at http://localhost:3001"
	@echo "User: admin"
	@echo "Password: $$(kubectl --context $(CONTEXT) get secret kube-prometheus-stack-grafana -n monitoring -o jsonpath='{.data.admin-password}' | base64 -d)"
	@echo "Dashboards: Dynamo Overview, Dynamo KV Block Manager, GTC Demo"
	kubectl --context $(CONTEXT) port-forward svc/kube-prometheus-stack-grafana 3001:80 -n monitoring

demo-ui: ## Port-forward load generator UI (http://localhost:3000)
	@echo "Load generator UI available at http://localhost:3000"
	kubectl --context $(CONTEXT) port-forward svc/loadgen 3000:3000 -n dynamo-workload

# --- Gateway Validation ---

test-gateway: ## Validate Gateway, TLS, DNS, and routing
	@echo "=== Gateway ==="
	kubectl --context $(CONTEXT) get gateway -n cluster-services
	@echo ""
	@echo "=== HTTPRoutes ==="
	kubectl --context $(CONTEXT) get httproute -A
	@echo ""
	@echo "=== TLS Certificate ==="
	kubectl --context $(CONTEXT) get certificate -n cluster-services
	@echo ""
	@echo "=== ClusterIssuer ==="
	kubectl --context $(CONTEXT) get clusterissuer
	@echo ""
	@echo "=== Gateway LB IP ==="
	kubectl --context $(CONTEXT) get svc -n cluster-services -l io.cilium.gateway/owning-gateway
	@echo ""
	@echo "=== DNS ==="
	dig +short $(HOSTNAME) || echo "DNS not yet propagated"
	@echo ""
	@echo "=== HTTPS ==="
	curl -sf -o /dev/null -w "HTTP %{http_code}\n" https://$(HOSTNAME)/ || echo "Not yet reachable"
	curl -sf -o /dev/null -w "HTTP %{http_code}\n" https://$(HOSTNAME)/grafana || echo "Not yet reachable"

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

test-kv-cache: ## Test KV cache hit behavior
	@echo "TODO: Implement test-kv-cache"

capacity-test: ## Run staircase capacity test (find max concurrency/RPS)
	scripts/capacity-test.sh --context $(CONTEXT) --output-dir dev

benchmark-sweep: ## Run A/B benchmark: KV-aware vs round-robin routing (~65 min)
	scripts/benchmark-sweep.sh --context $(CONTEXT) --output-dir dev
	python3 scripts/generate-benchmark-report.py --input 'dev/benchmark-sweep-*.tsv' --output-dir dev

collect-conversations: ## Collect conversations from load generator and create benchmark dataset
	@echo "Port-forwarding to load generator..."
	@kubectl --context $(CONTEXT) port-forward svc/loadgen 3000:3000 -n dynamo-workload &
	@sleep 2
	@echo "Collecting conversations..."
	@python3 scripts/collect-conversations.py \
		--url http://localhost:3000 \
		--target 100 \
		--output-dir dev/vllm/benchmarks/datasets || { kill %1 2>/dev/null; exit 1; }
	@kill %1 2>/dev/null || true
	@echo ""
	@echo "Done. Upload the ShareGPT dataset to NFS and update DATASET_PATH in the benchmark Job YAML."

phase1-sweep: check-env ## Run Phase 1 parameter sweep benchmark (~4-6 hours)
	@echo "Creating ConfigMap with sweep + benchmark scripts..."
	kubectl --context $(CONTEXT) create configmap vllm-phase1-scripts \
		--from-file=vllm-phase1-sweep.sh=scripts/vllm-phase1-sweep.sh \
		--from-file=vllm-benchmark.sh=scripts/vllm-benchmark.sh \
		-n dynamo-workload --dry-run=client -o yaml | kubectl --context $(CONTEXT) apply -f -
	@echo "Deleting previous sweep Job (if any)..."
	-kubectl --context $(CONTEXT) delete job vllm-phase1-sweep -n dynamo-workload --ignore-not-found=true
	@echo "Applying Phase 1 sweep Job..."
	kubectl --context $(CONTEXT) apply -f k8s/benchmarks/vllm-phase1-sweep-job.yaml
	@echo ""
	@echo "Phase 1 sweep Job submitted. Monitor with:"
	@echo "  kubectl logs -f job/vllm-phase1-sweep -n dynamo-workload --context $(CONTEXT)"

validate-all: test-inference test-kv-cache ## Run all validation tests
