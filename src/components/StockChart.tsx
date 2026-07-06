// Minimal SVG line chart of an underlying stock's daily closes, with an optional
// dashed strike line. Presentational + theme-aware (uses CSS vars).
export default function StockChart({ closes, strike }: { closes: number[]; strike?: number }) {
  if (closes.length < 2) {
    return <p className="text-xs text-muted text-center py-8">No chart data available.</p>;
  }
  const w = 320;
  const h = 130;
  const pad = 10;
  const vals = strike != null ? [...closes, strike] : closes;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const x = (i: number) => pad + (i / (closes.length - 1)) * (w - 2 * pad);
  const y = (v: number) => pad + (1 - (v - min) / range) * (h - 2 * pad);
  const path = closes.map((c, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(" ");
  const up = closes[closes.length - 1] >= closes[0];
  const stroke = up ? "var(--up)" : "var(--down)";

  return (
    <div className="bg-panel border border-border rounded-2xl p-3">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto" preserveAspectRatio="none">
        {strike != null && (
          <line
            x1={pad}
            x2={w - pad}
            y1={y(strike)}
            y2={y(strike)}
            stroke="var(--muted)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        )}
        <path d={path} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="flex justify-center gap-4 mt-1 text-[11px] text-muted">
        <span>~{closes.length} trading days</span>
        {strike != null && <span>-, strike (target)</span>}
      </div>
    </div>
  );
}
