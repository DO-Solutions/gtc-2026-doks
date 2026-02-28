import { getAllBenchmarkLevels, getBenchmark } from '../data/rr-benchmark';

function sloClass(metric: 'ttft' | 'tpot', valueMs: number): string {
  const slo = metric === 'ttft' ? 600 : 60;
  if (valueMs >= slo) return 'slo-red';
  if (valueMs >= slo * 0.9) return 'slo-yellow';
  return 'slo-green';
}

function pctImprove(rr: number, kv: number): string {
  if (rr === 0) return '-';
  const pct = ((rr - kv) / rr) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

export function BenchmarkTable() {
  const levels = getAllBenchmarkLevels();

  return (
    <div className="benchmark-table-section">
      <h2>Benchmark Comparison (TTFT & TPOT p95)</h2>
      <div className="benchmark-table-wrap">
        <table className="benchmark-table">
          <thead>
            <tr>
              <th rowSpan={2}>Concurrency</th>
              <th colSpan={3}>TTFT p95 (ms)</th>
              <th colSpan={3}>TPOT p95 (ms)</th>
            </tr>
            <tr>
              <th>RR</th>
              <th>KV</th>
              <th>Improvement</th>
              <th>RR</th>
              <th>KV</th>
              <th>Improvement</th>
            </tr>
          </thead>
          <tbody>
            {levels.map((c) => {
              const b = getBenchmark(c);
              return (
                <tr key={c}>
                  <td className="bench-concurrency">{c}</td>
                  <td className={sloClass('ttft', b.rr.ttft.p95)}>{b.rr.ttft.p95}</td>
                  <td className={sloClass('ttft', b.kv.ttft.p95)}>{b.kv.ttft.p95}</td>
                  <td className="bench-improve">{pctImprove(b.rr.ttft.p95, b.kv.ttft.p95)}</td>
                  <td className={sloClass('tpot', b.rr.tpot.p95)}>{b.rr.tpot.p95}</td>
                  <td className={sloClass('tpot', b.kv.tpot.p95)}>{b.kv.tpot.p95}</td>
                  <td className="bench-improve">{pctImprove(b.rr.tpot.p95, b.kv.tpot.p95)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
