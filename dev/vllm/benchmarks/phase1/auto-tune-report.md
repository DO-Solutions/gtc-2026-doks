# Phase 1 Parameter Tuning — Benchmark Report

**Generated:** 2026-02-25 06:52:15 UTC

## Configuration

| # | Label | gpu-memory-util | max-num-batched-tokens | max-num-seqs | KV Cache | Description |
|:-:|-------|:-:|:-:|:-:|--------|-------------|
| 0 | phase0 (baseline) | 0.9 | 8192 | 1024 | 53.15 GiB | Phase 0 custom dataset baseline |
| 1 | phase1-baseline-rerun | 0.9 | 8192 | 1024 | 53.15 GiB | Control — same as Phase 0 defaults |
| 2 | phase1-mem095 | 0.95 | 8192 | 1024 | 60.14 GiB | Isolate memory effect (+~7GB KV cache) |
| 3 | phase1-batch16k | 0.9 | 16384 | 1024 | 53.02 GiB | Isolate prefill budget effect (2x default) |
| 4 | phase1-seqs128 | 0.9 | 8192 | 128 | 56.39 GiB | Isolate max-seqs effect (avoids preemption) |
| 5 | phase1-moderate | 0.95 | 16384 | 128 | 61.79 GiB | Combined moderate tuning |
| 6 | phase1-aggressive | 0.95 | 32768 | 256 | 56.85 GiB | Combined aggressive tuning |

## SLO Targets

| Metric | Target |
|--------|--------|
| TTFT p99 | < 1000ms |
| TPOT p99 | < 60ms |

## Results — TTFT p99 (ms)

| Rate | phase0 | phase1-baseline-rerun | phase1-mem095 | phase1-batch16k | phase1-seqs128 | phase1-moderate | phase1-aggressive |
|-----:|--------:|--------:|--------:|--------:|--------:|--------:|--------:|
| 0.50 | 770 | 769 | 748 | 777 | 757 | 771 | 774 |
| 0.75 | 646 | 652 | 580 | 646 | 620 | 576 | 593 |
| 1.00 | 703 | 698 | 597 | 702 | 632 | 516 | 689 |
| 1.25 | 801 | 798 | 627 | 799 | 793 | 624 | 773 |
| 1.50 | 981 | 984 | 641 | 890 | 668 | 634 | 681 |
| 2.00 | 953 | 1010 | 839 | 958 | 943 | 849 | 885 |
| 2.50 | 978 | 970 | 877 | 977 | 892 | 976 | 962 |
| 3.00 | 1020 | 1011 | 1003 | 896 | 1007 | 873 | 1006 |
| 3.50 | — | 1021 | 1034 | 1057 | 2736 | 2958 | 1002 |
| 4.00 | — | 1090 | 1013 | 1060 | 11980 | 10276 | 1010 |
| 4.50 | — | 1101 | 1093 | 1084 | 19101 | 18191 | 1075 |
| 5.00 | — | 1195 | 1185 | 1197 | 24790 | 23158 | 1191 |

## Results — TPOT p99 (ms)

| Rate | phase0 | phase1-baseline-rerun | phase1-mem095 | phase1-batch16k | phase1-seqs128 | phase1-moderate | phase1-aggressive |
|-----:|--------:|--------:|--------:|--------:|--------:|--------:|--------:|
| 0.50 | 29 | 29 | 29 | 29 | 29 | 29 | 29 |
| 0.75 | 34 | 34 | 34 | 34 | 33 | 32 | 32 |
| 1.00 | 41 | 41 | 39 | 41 | 40 | 38 | 40 |
| 1.25 | 42 | 42 | 40 | 41 | 42 | 40 | 42 |
| 1.50 | 43 | 43 | 42 | 43 | 43 | 41 | 43 |
| 2.00 | 49 | 48 | 45 | 49 | 46 | 44 | 46 |
| 2.50 | 67 | 66 | 63 | 66 | 63 | 62 | 64 |
| 3.00 | 75 | 75 | 72 | 75 | 73 | 71 | 73 |
| 3.50 | — | 90 | 88 | 95 | 82 | 82 | 87 |
| 4.00 | — | 104 | 97 | 101 | 85 | 83 | 100 |
| 4.50 | — | 106 | 103 | 107 | 84 | 85 | 104 |
| 5.00 | — | 109 | 106 | 108 | 85 | 83 | 107 |

## Results — Output Throughput (tok/s)

| Rate | phase0 | phase1-baseline-rerun | phase1-mem095 | phase1-batch16k | phase1-seqs128 | phase1-moderate | phase1-aggressive |
|-----:|--------:|--------:|--------:|--------:|--------:|--------:|--------:|
| 0.50 | 252 | 252 | 251 | 251 | 251 | 251 | 252 |
| 0.75 | 371 | 371 | 366 | 372 | 368 | 359 | 367 |
| 1.00 | 485 | 486 | 476 | 487 | 487 | 480 | 490 |
| 1.25 | 594 | 594 | 590 | 591 | 588 | 583 | 592 |
| 1.50 | 695 | 687 | 682 | 691 | 691 | 684 | 692 |
| 2.00 | 867 | 866 | 871 | 876 | 872 | 860 | 869 |
| 2.50 | 1008 | 1001 | 1006 | 1008 | 1009 | 1013 | 1006 |
| 3.00 | 1110 | 1112 | 1113 | 1116 | 1120 | 1116 | 1119 |
| 3.50 | — | 1155 | 1176 | 1159 | 1185 | 1189 | 1175 |
| 4.00 | — | 1184 | 1209 | 1191 | 1198 | 1212 | 1202 |
| 4.50 | — | 1226 | 1235 | 1231 | 1217 | 1227 | 1229 |
| 5.00 | — | 1260 | 1273 | 1265 | 1229 | 1245 | 1267 |

## Results — Max Concurrent Requests

| Rate | phase0 | phase1-baseline-rerun | phase1-mem095 | phase1-batch16k | phase1-seqs128 | phase1-moderate | phase1-aggressive |
|-----:|--------:|--------:|--------:|--------:|--------:|--------:|--------:|
| 0.50 | 16 | 17 | 17 | 17 | 17 | 17 | 17 |
| 0.75 | 20 | 20 | 20 | 20 | 20 | 20 | 20 |
| 1.00 | 30 | 28 | 28 | 29 | 28 | 27 | 28 |
| 1.25 | 35 | 35 | 34 | 36 | 34 | 34 | 34 |
| 1.50 | 41 | 41 | 40 | 41 | 41 | 40 | 40 |
| 2.00 | 59 | 58 | 53 | 59 | 57 | 54 | 56 |
| 2.50 | 89 | 92 | 84 | 90 | 89 | 82 | 85 |
| 3.00 | 112 | 114 | 112 | 115 | 112 | 110 | 113 |
| 3.50 | — | 147 | 143 | 145 | 141 | 141 | 141 |
| 4.00 | — | 167 | 156 | 163 | 162 | 158 | 163 |
| 4.50 | — | 177 | 173 | 180 | 189 | 186 | 174 |
| 5.00 | — | 188 | 180 | 188 | 190 | 194 | 182 |

## SLO Compliance Matrix

PASS = TTFT p99 < 1000ms AND TPOT p99 < 60ms

| Rate | phase0 | phase1-baseline-rerun | phase1-mem095 | phase1-batch16k | phase1-seqs128 | phase1-moderate | phase1-aggressive |
|-----:|--------|--------|--------|--------|--------|--------|--------|
| 0.50 | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| 0.75 | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| 1.00 | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| 1.25 | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| 1.50 | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| 2.00 | PASS | FAIL (TTFT) | PASS | PASS | PASS | PASS | PASS |
| 2.50 | FAIL (TPOT) | FAIL (TPOT) | FAIL (TPOT) | FAIL (TPOT) | FAIL (TPOT) | FAIL (TPOT) | FAIL (TPOT) |
| 3.00 | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TPOT) | FAIL (TTFT+TPOT) | FAIL (TPOT) | FAIL (TTFT+TPOT) |
| 3.50 | — | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) |
| 4.00 | — | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) |
| 4.50 | — | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) |
| 5.00 | — | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) | FAIL (TTFT+TPOT) |

## Winner Identification

| Label | Max SLO-Compliant Rate | Capacity vs Baseline |
|-------|:----------------------:|:--------------------:|
| phase0 | 2.00 | — |
| phase1-baseline-rerun | 1.50 | -25% |
| phase1-mem095 **WINNER** | 2.00 | +0% |
| phase1-batch16k **WINNER** | 2.00 | +0% |
| phase1-seqs128 **WINNER** | 2.00 | +0% |
| phase1-moderate **WINNER** | 2.00 | +0% |
| phase1-aggressive **WINNER** | 2.00 | +0% |

**No combo improved over baseline.**

## Detailed Comparison at Baseline Max Rate (2.00 RPS)

| Metric | phase0 | phase1-baseline-rerun | phase1-mem095 | phase1-batch16k | phase1-seqs128 | phase1-moderate | phase1-aggressive |
|--------|--------:|--------:|--------:|--------:|--------:|--------:|--------:|
| TTFT p50 (ms) | 130 | 128 | 118 | 129 | 119 | 113 | 119 |
| TTFT p95 (ms) | 605 | 580 | 519 | 593 | 538 | 517 | 539 |
| TTFT p99 (ms) | 953 | 1010 | 839 | 958 | 943 | 849 | 885 |
| TPOT p50 (ms) | 45 | 44 | 42 | 45 | 43 | 41 | 43 |
| TPOT p95 (ms) | 48 | 47 | 44 | 48 | 46 | 44 | 45 |
| TPOT p99 (ms) | 49 | 48 | 45 | 49 | 46 | 44 | 46 |
| ITL p50 (ms) | 38 | 38 | 37 | 38 | 38 | 37 | 38 |
| ITL p99 (ms) | 232 | 227 | 186 | 228 | 220 | 181 | 221 |
| Max Concurrent | 59 | 58 | 53 | 59 | 57 | 54 | 56 |
| Output tok/s | 867 | 866 | 871 | 876 | 872 | 860 | 869 |
| Completed | 300 | 300 | 300 | 300 | 300 | 300 | 300 |
| Failed | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Key Observations

1. **TPOT p99 is the binding constraint.** All configs fail TPOT p99 < 60ms at 2.5 RPS. This is fundamental — decode is memory-bandwidth bound on a single H200, and parameter tuning cannot speed up the autoregressive decode pipeline itself.

2. **No config pushes max SLO rate above 2.0 RPS.** The ceiling is set by the model's decode throughput per GPU. To break through 2.0 RPS on this workload (avg ~5,800 input tokens), we would need TP>1 (more decode bandwidth) or speculative decoding (more tokens per forward pass).

3. **`phase1-moderate` delivers the best latency within the SLO-compliant range.** At 2.0 RPS: TTFT p99 drops 11% (953→849ms), TPOT p99 drops 10% (49→44ms), ITL p99 drops 22% (232→181ms). More headroom means more resilience to traffic bursts.

4. **Baseline rerun scored lower (1.50 RPS) than Phase 0 (2.00 RPS).** At 2.0 RPS, the rerun's TTFT p99 = 1010ms vs Phase 0's 953ms — both near the 1000ms boundary. This ~6% variation is expected with Poisson arrival and confirms Phase 0 was near the SLO edge.

5. **KV cache sizing.** `gpu-memory-utilization 0.95` adds ~7 GiB of KV cache (53→60 GiB). Combined with `max-num-seqs 128`, the moderate config reaches 61.8 GiB — the largest cache of any config. More cache means fewer preemptions under sustained load.

6. **`max-num-seqs` caps create queuing at overload.** At 3.5+ RPS, seqs128 and moderate show TTFT p99 in the 3-25 second range (requests queue waiting for a slot) while other configs stay at ~1s. However, their TPOT stays lower (82-85ms vs 88-109ms) because fewer concurrent requests reduce decode contention. Within SLO range (≤2.0 RPS), queuing doesn't occur, so the TPOT benefit is free.

7. **`max-num-batched-tokens 16384` alone has minimal impact.** batch16k tracks very close to baseline at every rate — the prefill budget increase doesn't help because our long prompts (avg 5,800 tokens) already fit within the 8192 default.

8. **Recommendation: apply `phase1-moderate` config** (`--gpu-memory-utilization 0.95 --max-num-batched-tokens 16384 --max-num-seqs 128`). It provides the best latency at target operating range without increasing max rate — a "quality of service" improvement rather than a capacity improvement.

## Workload Parameters

| Parameter | Value |
|-----------|-------|
| Tool | `vllm bench serve` (vLLM 0.14.1) |
| Dataset | Custom multi-turn conversations (avg ~5,806 input tokens) |
| Prompts per Rate | 300 |
| Request Rates | 0.50, 0.75, 1.00, 1.25, 1.50, 2.00, 2.50, 3.00, 3.50, 4.00, 4.50, 5.00 RPS |
| Arrival Distribution | Poisson (burstiness=1.0) |
| Warm-up | 10 prompts at 0.5 RPS, 15s cooldown |
| Cooldown Between Rates | 30s |

