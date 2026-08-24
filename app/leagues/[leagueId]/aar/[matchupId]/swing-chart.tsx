import type { AfterActionReport } from '@/lib/aar/build';

/**
 * The swing chart, drawn as inline SVG. No chart library: the shape is one
 * polyline and a fill, and the whole point is that it renders on a server
 * component with nothing to hydrate.
 *
 * The curve is always drawn from the viewer's perspective — a manager reading
 * their own AAR should see their own line rise when they were winning, whichever
 * side of the stored snapshot they happen to be.
 */
export function SwingChart({ report }: { report: AfterActionReport }) {
  const points = report.swingChart;
  if (points.length < 2) {
    return (
      <div className="card">
        <p className="faint" style={{ margin: 0, fontSize: 13 }}>
          No odds snapshots were captured for this matchup, so there is no curve to draw. The
          live poller writes one tick per minute during game windows.
        </p>
      </div>
    );
  }

  const width = 720;
  const height = 200;
  const padding = { top: 12, right: 12, bottom: 22, left: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const firstAt = new Date(points[0]!.at).getTime();
  const lastAt = new Date(points[points.length - 1]!.at).getTime();
  const span = Math.max(lastAt - firstAt, 1);

  const x = (at: string) =>
    padding.left + ((new Date(at).getTime() - firstAt) / span) * plotWidth;
  const y = (probability: number) => padding.top + (1 - probability) * plotHeight;

  const viewerProbability = (winProbA: number) =>
    report.isSideA ? winProbA : 1 - winProbA;

  const line = points
    .map((point) => `${x(point.at).toFixed(1)},${y(viewerProbability(point.winProbA)).toFixed(1)}`)
    .join(' ');

  const area = `${padding.left},${y(0)} ${line} ${x(points[points.length - 1]!.at).toFixed(1)},${y(0)}`;

  const peak = points.reduce((best, point) =>
    viewerProbability(point.winProbA) > viewerProbability(best.winProbA) ? point : best,
  );
  const trough = points.reduce((worst, point) =>
    viewerProbability(point.winProbA) < viewerProbability(worst.winProbA) ? point : worst,
  );

  return (
    <div className="card">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label={`Win probability for ${report.manager} over the course of the week`}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((level) => (
          <g key={level}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={y(level)}
              y2={y(level)}
              stroke={level === 0.5 ? 'var(--text-faint)' : 'var(--border)'}
              strokeDasharray={level === 0.5 ? '3 3' : undefined}
            />
            <text
              x={padding.left - 6}
              y={y(level) + 3.5}
              textAnchor="end"
              fontSize="9"
              fill="var(--text-faint)"
            >
              {level * 100}
            </text>
          </g>
        ))}

        <polygon points={area} fill={report.won ? 'rgba(74,222,128,.12)' : 'rgba(248,113,113,.10)'} />
        <polyline
          points={line}
          fill="none"
          stroke={report.won ? 'var(--accent)' : 'var(--danger)'}
          strokeWidth="2"
          strokeLinejoin="round"
        />

        <circle
          cx={x(peak.at)}
          cy={y(viewerProbability(peak.winProbA))}
          r="3.5"
          fill="var(--accent)"
        />
        <circle
          cx={x(trough.at)}
          cy={y(viewerProbability(trough.winProbA))}
          r="3.5"
          fill="var(--danger)"
        />
      </svg>

      <div className="odds-meta" style={{ marginTop: 4 }}>
        <span>
          Peak <strong>{Math.round(viewerProbability(peak.winProbA) * 100)}%</strong>
        </span>
        <span>
          Low <strong>{Math.round(viewerProbability(trough.winProbA) * 100)}%</strong>
        </span>
        <span>{points.length} ticks captured</span>
      </div>
    </div>
  );
}
