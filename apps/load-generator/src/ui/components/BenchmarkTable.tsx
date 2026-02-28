import { useState, useEffect, useRef } from 'react';
import { getAllBenchmarkLevels, getBenchmark } from '../data/rr-benchmark';
import { InfoIcon } from './InfoIcon';

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
  const [openPopover, setOpenPopover] = useState<string | null>(null);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openPopover) return;
    function handleClick(e: MouseEvent) {
      if (sectionRef.current && !sectionRef.current.contains(e.target as Node)) {
        setOpenPopover(null);
      }
    }
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [openPopover]);

  return (
    <div className="benchmark-table-section" ref={sectionRef} onClick={() => setOpenPopover(null)}>
      <h2><span className="section-title">Static Benchmark Comparison <InfoIcon id="bench-header" description="Pre-recorded p95 latency benchmarks at various concurrency levels. Green = within SLO, yellow = within 90% of SLO, red = exceeds SLO. SLOs: TTFT < 600ms, TPOT < 60ms." openPopover={openPopover} setOpenPopover={setOpenPopover} /></span></h2>
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
