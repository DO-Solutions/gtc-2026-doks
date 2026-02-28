We need to make the following updates to the UI.

# Benchmark data
## Results

| Concurrency | RR TTFT p50 | KV TTFT p50 | p50 Improvement | RR TTFT p95 | KV TTFT p95 | p95 Improvement | RR Hit Rate | KV Hit Rate |
|:-----------:|:-----------:|:-----------:|:---------------:|:-----------:|:-----------:|:---------------:|:-----------:|:-----------:|
| 60 | 274ms | 249ms | 9.3% | 655ms | 446ms | 32.0% | 90.9% | 91.6% |
| 80 | 306ms | 267ms | 12.8% | 637ms | 508ms | 20.2% | 85.3% | 95.7% |
| 100 | 342ms | 329ms | 3.9% | 652ms | 547ms | 16.2% | 88.5% | 96.1% |
| 120 | 375ms | 382ms | -2.0% | 643ms | 530ms | 17.6% | 87.2% | 95.9% |
| 140 | 398ms | 415ms | -4.1% | 643ms | 650ms | -1.1% | 83.9% | 91.2% |
| 160 | 422ms | 424ms | -0.5% | 722ms | 704ms | 2.5% | 90.1% | 95.3% |
| 180 | 413ms | 472ms | -14.1% | 732ms | 3143ms | -329.6% | 88.9% | 94.0% |

### Throughput and Actual RPS

| Concurrency | RR TOPS | KV TOPS | Improvement | RR RPS | KV RPS |
|:-----------:|:-------:|:-------:|:-----------:|:------:|:------:|
| 60 | 2146.9 | 2262.8 | 5.4% | 2.60 | 2.57 |
| 80 | 2543.2 | 2742.3 | 7.8% | 2.93 | 3.17 |
| 100 | 2547.5 | 2780.1 | 9.1% | 2.96 | 3.19 |
| 120 | 2642.6 | 2805.7 | 6.2% | 3.05 | 3.53 |
| 140 | 2816.8 | 3167.8 | 12.5% | 3.29 | 3.68 |
| 160 | 3126.8 | 3471.8 | 11.0% | 3.66 | 4.06 |
| 180 | 3434.0 | 3907.7 | 13.8% | 4.10 | 4.61 |

### ITL -- Inter-Token Latency

| Concurrency | RR ITL p50 | KV ITL p50 | RR ITL p95 | KV ITL p95 |
|:-----------:|:----------:|:----------:|:----------:|:----------:|
| 60 | 28ms | 26ms | 30ms | 27ms |
| 80 | 31ms | 28ms | 33ms | 33ms |
| 100 | 38ms | 36ms | 48ms | 43ms |
| 120 | 45ms | 43ms | 50ms | 46ms |
| 140 | 49ms | 44ms | 52ms | 46ms |
| 160 | 51ms | 46ms | 54ms | 48ms |
| 180 | 52ms | 45ms | 54ms | 48ms |

### End-to-End Latency
We should translate this into second with one decimal place precision -- 27674ms becomes 27.7

| Concurrency | RR Latency p50 | KV Latency p50 | RR Latency p95 | KV Latency p95 |
|:-----------:|:--------------:|:--------------:|:--------------:|:--------------:|
| 60 | 24636ms | 24326ms | 30114ms | 27674ms |
| 80 | 29269ms | 26575ms | 33357ms | 32526ms |
| 100 | 32060ms | 31812ms | 48957ms | 43614ms |
| 120 | 41154ms | 38095ms | 50363ms | 47221ms |
| 140 | 45682ms | 38712ms | 52955ms | 46715ms |
| 160 | 45178ms | 40771ms | 55427ms | 48144ms |
| 180 | 46065ms | 41433ms | 54570ms | 48657ms |

# Demo Title
- change to "Serve More Users on the Same GPUs with KV-Aware Routing"
- Subtitle set to "Powered by NVIDIA Dynamo and DigitalOcean Kubernetes Service"

# Live metrics vs benchmark
- The slider should go from 60 to 180 in increments of 20.
- We should be able to see the current p50 and p95 (calculated over the last minute) vs benchmark at that same concurrency using RR for the following metrics:
  - TTFT
  - TPOT
  - ITL
  - E2E Latency
- We should be able to see the current TOPS vs the benchmark at that same concurrency that same concurrency using RR
- These live metrics should allow a viewer to answer the question how much better basing on this real test is KV vs RR.
- The live metrics should have a green, yellow, red scale based on the SLOs of p95 TTFT 600ms and TPOT 60ms

# Other live metrics:
- We want to see these live, but do not need to compare with benchmark (average over the last minute):
  - RPS
  - Requests (total completed over last minute)
  - Errors
  - GPU processor and Mem utilization

# Visibility of KV vs RR values for all concurrences
- We want the live metrics to be obviously compared to the RR benchmark, but we also want to sho how TTFT and TPOT compares at the various concurrency levels between RR and KV cache.
- This should allow the user to see how KV vs RR compare regardless of what the real time concurrency is set to. And be able to see how it compares in the upper amount of concurrency.
- Our SLOs are p95 600ms TTFT and 60ms TOPS, so a viewer should be able to understand how KV compares at every concurrency level

# Additional tabs for info graphics.
- Three aditional tabs (added to Dashboard, Conversations) with each one showing an infographic
  - Demo Arch - content/do-demo-arch.png
  - Routing Arch - content/kv-cache-arch.png
  - Dynamo Features - content/dynamo-features.png

# Conversations Tab
- Change the latency to seconds with one decimal place precision.