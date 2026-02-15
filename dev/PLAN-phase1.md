# Phase 1 Implementation Plan: KV-Aware Routing with Aggregated TP=4 Replicas

## Context

We are pivoting from disaggregated serving (separate prefill/decode worker pools with NIXL KV transfers) to aggregated serving (2 independent TP=4 replicas with KV-aware routing). Disaggregated serving requires RDMA for performant inter-pod KV cache transfers; our DOKS environment only has TCP, making disaggregation unviable.

The new architecture runs 2 aggregated TP=4 replicas of Llama 3.1 70B Instruct FP8 on a single 8-GPU node. Each replica handles its own prefill and decode internally. Dynamo's KV-aware router directs multi-turn conversations to the replica already holding their KV cache, eliminating redundant prefill on turn 2+.

**Previous state preserved at git tag `disagg-v1`.**

**Reference:** `dev/PROJECT-spec.md` contains the full project specification for the new direction.

---

## Group 1: New DGD Configuration

**Goal:** Replace the disaggregated DGD CR (frontend + prefill workers + decode workers) with an aggregated DGD CR (frontend + 2 TP=4 replicas).

**File to create:** `k8s/dynamo/dev-agg.yaml`
**Reference:** `k8s/dynamo/dev-disagg.yaml` (current, keep in repo for historical reference)

### Key Design Points

- DGD name: `gtc-demo` (unchanged), namespace: `dynamo-workload`
- `nvidia.com/enable-grove: "false"` annotation (operator creates Deployments, not PodCliques)
- **Frontend service:** Same as current
  - Image: `nvidia/ai-dynamo/dynamo-frontend:0.9.0`
  - Router mode: `DYN_ROUTER_MODE: kv` (KV-aware routing)
  - 1 replica, no GPU, model NFS mount at `/models`
  - POD_UID env var via downward API
- **Single worker service** (`TrtllmWorker`): Replaces both `TrtllmPrefillWorker` and `TrtllmDecodeWorker`
  - `componentType: worker` (no `subComponentType` — aggregated, not disaggregated)
  - 2 replicas (fixed — no `scalingAdapter`)
  - `resources.limits: nvidia.com/gpu: "4"` (TP=4, each pod gets 4 GPUs)
  - `--tensor-parallel-size 4`
  - `--model-path /models/nvidia/Llama-3.1-70B-Instruct-FP8`
  - No `--disaggregation-mode` flag
  - No `cache_transceiver_config` in `--override-engine-args` (no NIXL — aggregated workers don't do inter-pod KV transfer)
  - Remove all UCX env vars (`UCX_TLS`, `UCX_RNDV_SCHEME`, `UCX_RNDV_THRESH`, `UCX_POSIX_USE_PROC_LINK`)
  - Keep: `hostIPC: true` (needed for TP=4 NVLink within each replica), `IPC_LOCK` capability, CUDA compat volume mount
  - Keep: GPU toleration (`nvidia.com/gpu:NoSchedule`), KAI queue label (`kai.scheduler/queue: default-queue`), RuntimeClass `nvidia`
  - `--free-gpu-memory-fraction 0.85` (can be higher without NIXL buffers)
  - Keep in `--override-engine-args`: `enable_chunked_prefill: true`, `kv_cache_config: {dtype: fp8}`
  - Keep: `--publish-events-and-metrics`, `--trust-remote-code`
  - `--max-batch-size 16`, `--max-num-tokens 8192` (same as current, tune after baseline)

### Dynamo Reference Examples to Consult

- `examples/recipes/llama-3-70b/vllm/agg/deploy.yaml` — aggregated DGD structure
- `examples/backends/trtllm/` — TRT-LLM backend configs with `gpu: "4"` and `--tensor-parallel-size 4`

---

## Group 2: Makefile Updates

**File:** `Makefile`

### Changes

1. **Title comment** (line 1): Change to `# GTC 2026 Optimized LLM Inference Demo`
2. **MODEL** (line 13): Change from `nvidia/Llama-3.1-8B-Instruct-FP8` to `nvidia/Llama-3.1-70B-Instruct-FP8`
3. **Remove NVLINK_ENABLED** variable (line 16): No longer templated — `hostIPC: true` is hardcoded in the new DGD CR, not driven by envsubst
4. **deploy-dynamo target** (line ~123):
   - Change manifest from `$(ENV)-disagg.yaml` to `$(ENV)-agg.yaml`
   - Remove `NVLINK_ENABLED=$(NVLINK_ENABLED)` from the `envsubst` call (or remove envsubst entirely if no other vars need substitution — check if `MODEL` or `MODEL_SLUG` are still templated)
   - Keep `wait-for-dynamo.sh` call (still expecting 3 pods)
5. **deploy-apps target** (line ~156): Remove `deploy-keda` from the dependency chain. New chain: `deploy-dynamo` → `deploy-loadgen` → `deploy-corpus` → `deploy-gateway`
6. **demo-start target** (line ~167): Change default mix from `{"totalRPS":2,"mix":{"a":0.4,"b":0.3,"c":0.3},"maxConcurrency":10}` to `{"totalRPS":2,"mix":{"a":1.0,"b":0,"c":0},"maxConcurrency":10}`
7. **validate-all target** (line ~266): Remove `test-disagg` and `test-scaling`. Keep `test-inference` and `test-kv-cache`.

---

## Group 3: KEDA — Not Deployed

No file changes needed. Simply don't deploy:

- `k8s/keda/prefill-scaler.yaml` and `decode-scaler.yaml` stay in the repo (preserved by git tag) but are not applied
- The KEDA Helm release remains in Stack 2 Terraform (harmless without ScaledObjects targeting it)
- `deploy-keda` target stays in the Makefile but is removed from the `deploy-apps` dependency chain

---

## Group 4: Load Generator Server Changes

**Goal:** Simplify the load generator for Phase 1. Keep workloads B and C in code (they still work if manually selected) but default to multi-turn chat only. Remove DGDSA scaling and KEDA pause/resume from the scenario controller.

### 4a. Config (`apps/load-generator/src/server/config.ts`)

**Remove these config keys:**
- `dgdsaPrefillName` (currently: `gtc-demo-trtllmprefillworker`)
- `dgdsaDecodeName` (currently: `gtc-demo-trtllmdecodeworker`)
- `kedaScaledObjects` (currently: comma-separated ScaledObject names)
- `scenarioInitialPrefillReplicas` (currently: 1)
- `scenarioInitialDecodeReplicas` (currently: 1)

**Keep everything else:** `port`, `dynamoFrontendUrl`, `modelName`, `spacesEndpoint`, `spacesBucket`, `metricsWindowSec`, `defaultRPS`, `defaultMaxConcurrency`, `k8sNamespace`, serverless inference config, etc.

### 4b. K8s Scaler (`apps/load-generator/src/server/k8s-scaler.ts`)

Make all methods no-ops (stub out). The module interface stays so callers don't need to be refactored, but methods do nothing:

- `scaleDGDSA()` → no-op (log "scaling disabled in Phase 1" at debug level)
- `pauseKEDA()` → no-op
- `resumeKEDA()` → no-op

### 4c. Scenario Controller (`apps/load-generator/src/server/scenario-controller.ts`)

**Major rewrite.** Replace 8 disaggregated phases with 4 simpler load-driving phases:

| Phase | Duration | Mix | RPS | MaxConcurrency | Description |
|-------|----------|-----|-----|----------------|-------------|
| `RAMP_UP` | 60s | a:1.0 | 1.0 | 5 | Gradually increase multi-turn conversations |
| `STEADY_STATE` | 120s | a:1.0 | 2.0 | 10 | Stable multi-turn chat load |
| `HIGH_LOAD` | 90s | a:1.0 | 4.0 | 20 | Increased concurrency to stress the system |
| `COOLDOWN` | 60s | a:1.0 | 0.5 | 5 | Decrease to baseline, brief pause |

**Remove:**
- All `scaler.scaleDGDSA()` calls
- All `scaler.pauseKEDA()` / `scaler.resumeKEDA()` calls
- `initialPrefillReplicas` / `initialDecodeReplicas` constructor parameters

**Keep:**
- Cyclic auto mode with tick timer
- WebSocket broadcast of `scenario_state`
- `schedulerControl` adapter for starting/stopping/updating workloads
- Phase countdown timer and cycle count

### 4d. Types

**`apps/load-generator/src/server/types.ts`** — Replace `ScenarioPhase` union:
```
'IDLE' | 'RAMP_UP' | 'STEADY_STATE' | 'HIGH_LOAD' | 'COOLDOWN'
```

**`apps/load-generator/src/ui/types.ts`** — Same change to `ScenarioPhase` union.

Keep all other types unchanged: `WorkloadType`, `WorkloadMix`, `RequestMetrics`, `ScenarioState`, etc.

### 4e. Server index.ts (`apps/load-generator/src/server/index.ts`)

- Update `ScenarioController` construction: remove `initialPrefillReplicas` / `initialDecodeReplicas` params (line ~97-105)
- Change default workload mix (line ~181) from `{ a: 0.4, b: 0.3, c: 0.3 }` to `{ a: 1.0, b: 0, c: 0 }`

### 4f. Deployment manifest (`apps/load-generator/k8s/deployment.yaml`)

**Remove env vars:**
- `DGDSA_PREFILL_NAME`
- `DGDSA_DECODE_NAME`
- `KEDA_SCALED_OBJECTS`
- `SCENARIO_INITIAL_PREFILL_REPLICAS`
- `SCENARIO_INITIAL_DECODE_REPLICAS`

**RBAC:** Can simplify (remove DGDSA and KEDA rules from the Role) or leave as-is (harmless no-ops since the scaler methods are stubbed out). Simplifying is cleaner.

---

## Group 5: Load Generator UI Changes

**Goal:** De-emphasize workloads B/C, update scenario phase labels, simplify presets.

### 5a. WorkloadSliders (`apps/load-generator/src/ui/components/WorkloadSliders.tsx`)

- Keep all three sliders functional (B and C still work if manually selected)
- No code changes needed — the default config drives the initial slider positions

### 5b. Scenario Presets

Replace the disaggregated presets with simpler load-level presets:

| Preset | RPS | Mix | MaxConcurrency |
|--------|-----|-----|----------------|
| Light Load | 1.0 | a:1.0 | 5 |
| Moderate Load | 2.0 | a:1.0 | 10 |
| Heavy Load | 4.0 | a:1.0 | 20 |

### 5c. AutoModeControls (`apps/load-generator/src/ui/components/AutoModeControls.tsx`)

Update `PHASE_LABELS` and `PHASE_DESCRIPTIONS` to match the new 4-phase cycle:

| Phase | Label | Description |
|-------|-------|-------------|
| `IDLE` | Idle | Auto mode stopped |
| `RAMP_UP` | Ramp Up | Gradually increasing multi-turn conversations |
| `STEADY_STATE` | Steady State | Stable multi-turn chat load |
| `HIGH_LOAD` | High Load | Increased concurrency stressing the system |
| `COOLDOWN` | Cooldown | Decreasing to baseline |

### 5d. App.tsx (`apps/load-generator/src/ui/App.tsx`)

Update `DEFAULT_CONFIG`:
- `totalRPS: 2`
- `mix: { a: 1.0, b: 0, c: 0 }`
- `maxConcurrency: 10`

---

## Group 6: Model Pipeline

The Makefile `MODEL` change to `nvidia/Llama-3.1-70B-Instruct-FP8` handles model selection automatically. Existing scripts use `MODEL` / `MODEL_SLUG` substitution.

### Timeout Check

**File:** `scripts/setup-model.sh`

Current `MODEL_TIMEOUT` is 1800 seconds (30 minutes). The 70B FP8 model is ~70GB vs ~8GB for 8B. Increase to 3600 seconds (1 hour) to accommodate larger downloads.

The timeout is set via `MODEL_TIMEOUT` env var (already overridable). Change the default in the script from `1800` to `3600`.

### No Other Changes

- NFS PVC and job templates use `MODEL` / `MODEL_SLUG` substitution — no template changes needed
- `make setup-model` will download the 70B model to the same NFS path structure

---

## Group 7: Grafana Dashboard

**File:** `terraform/cluster-config/dashboards/demo.json`

### Changes

1. **Dashboard title:** Change from `"GTC Demo: Disaggregated Inference on DigitalOcean"` to `"GTC Demo: Optimized LLM Inference"`
2. **Worker Pool Size panel:** Change from showing separate prefill/decode pool sizes to showing a single worker replica count. Update the Prometheus query to count pods with `nvidia.com/dynamo-graph-deployment-name=gtc-demo` label (excluding frontend).
3. **Queue Depth by Component panel:** Simplify to aggregate queue depth (no prefill/decode breakdown). If the query uses `subComponentType` labels, remove that grouping.
4. **Remove:** Any scaling event annotations (references to DGDSA replica changes)
5. **Keep unchanged:** TTFT, ITL, Request Rate, Inflight, KV Cache, GPU Utilization, Output Tokens/s, End-to-End Request Duration panels

### Future (Not This Session)

After baseline measurements: add horizontal reference lines for round-robin baseline TTFT/ITL values.

---

## Group 8: Terraform (Minimal)

**File:** `terraform/cluster-config/variables.tf`

Update `nvlink_enabled` variable description:
- From: `"Enable host IPC for NVLink KV cache transfers between disaggregated workers"`
- To: `"Enable host IPC for TP=4 intra-replica NVLink communication"`

Everything else stays:
- KEDA Helm release in Stack 2 is harmless (no ScaledObjects reference it)
- No other Terraform changes needed

---

## Group 9: Scripts

**File:** `scripts/wait-for-dynamo.sh`

Verify `EXPECTED=3` is still correct:
- With Grove disabled and `gpu: "4"`, the operator creates 1 pod per replica
- Expected pods: 1 frontend + 2 worker pods = 3 total
- `EXPECTED=3` is correct — no change needed

**File:** `scripts/setup-model.sh`

Change default `MODEL_TIMEOUT` from `1800` to `3600` (covered in Group 6).

---

## Validation Steps

After implementing all groups above, validate:

1. **DGD CR validity:** `kubectl apply --dry-run=client -f k8s/dynamo/dev-agg.yaml` succeeds (after envsubst if needed). Verify: 3 services (frontend + 1 worker type), worker has `gpu: "4"`, 2 replicas, no `subComponentType`, no `scalingAdapter`, no `cache_transceiver_config`, no UCX env vars, `hostIPC: true`.

2. **Makefile targets:** `make -n deploy-apps ENV=dev` shows the correct chain (`deploy-dynamo` → `deploy-loadgen` → `deploy-corpus` → `deploy-gateway`, no `deploy-keda`). `MODEL` variable is `nvidia/Llama-3.1-70B-Instruct-FP8`.

3. **Load generator builds:** `cd apps/load-generator && npm run build` completes without TypeScript errors. Verify `ScenarioPhase` type has 5 values (`IDLE`, `RAMP_UP`, `STEADY_STATE`, `HIGH_LOAD`, `COOLDOWN`).

4. **Scenario controller:** Review `scenario-controller.ts` — no references to `scaleDGDSA`, `pauseKEDA`, `resumeKEDA`, `initialPrefillReplicas`, `initialDecodeReplicas`. All phases use `mix: { a: 1.0 }`.

5. **K8s scaler:** `k8s-scaler.ts` methods are all no-ops.

6. **Load gen deployment manifest:** `deployment.yaml` has no `DGDSA_*` or `KEDA_*` or `SCENARIO_INITIAL_*` env vars.

7. **Grafana dashboard:** `demo.json` title is updated. No references to "disaggregated", "prefill pool", "decode pool" in panel titles.

8. **Terraform:** `variables.tf` `nvlink_enabled` description mentions "TP=4 intra-replica" not "KV cache transfers between disaggregated workers".

9. **Scripts:** `wait-for-dynamo.sh` expects 3 pods. `setup-model.sh` default timeout is 3600.

10. **No disaggregated references in active code paths:** Search for "disagg", "prefill_worker", "decode_worker", "NIXL", "cache_transceiver" in the modified files — should find none (except comments explaining the pivot, if any).

---

**Note:** Validation is part of this plan. The plan is only considered complete when all validation steps have been performed and results reported as a numbered list describing: (1) what was done, (2) how validation was performed, (3) validation results.







