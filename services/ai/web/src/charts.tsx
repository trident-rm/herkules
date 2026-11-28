/**
 * Time-series charts for the overview, on Recharts. Colours are CSS variables from
 * console.css, so both themes follow without re-rendering. Every chart has a legend
 * row when it shows more than one series, and a crosshair tooltip.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { tick } from "./format.ts";
import { Muted } from "./ui.tsx";

export interface Series {
  key: string;
  label: string;
  color: string;
  dashed?: boolean;
}

type Row = { t: string } & Record<string, unknown>;

const bucketTime = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function TimeChart({
  kind,
  data,
  series,
  bucketSeconds,
  window,
  format,
  height = 180,
}: {
  kind: "bars" | "lines";
  data: Row[];
  series: Series[];
  bucketSeconds: number;
  window: { from: string; to: string };
  format: (n: number) => string;
  height?: number;
}) {
  if (!data.some((row) => series.some((s) => typeof row[s.key] === "number"))) {
    return <Muted>No measurements in this range.</Muted>;
  }
  const axis = {
    stroke: "var(--muted)",
    fontSize: 11,
    tickLine: false,
    axisLine: false,
  } as const;
  const bucketLabel = (label: unknown) => {
    const start = Date.parse(String(label));
    const from = Math.max(start, Date.parse(window.from));
    const to = Math.min(start + bucketSeconds * 1000, Date.parse(window.to));
    return bucketTime.formatRange(from, to);
  };
  const common = (
    <>
      <CartesianGrid vertical={false} stroke="var(--grid)" />
      <XAxis
        dataKey="t"
        {...axis}
        minTickGap={40}
        tickFormatter={(t: string) => tick(t, bucketSeconds)}
      />
      <YAxis
        {...axis}
        width={64}
        tickFormatter={(n: number) => format(n)}
        allowDecimals={kind === "lines"}
      />
      <Tooltip
        cursor={kind === "bars" ? { fill: "var(--surface-2)" } : { stroke: "var(--line)" }}
        isAnimationActive={false}
        content={({ active, payload, label }) =>
          active && payload?.length ? (
            <div className="min-w-40 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-md">
              <p className="mb-1 text-muted-foreground">{bucketLabel(label)}</p>
              {series.map((s) => {
                const v = payload.find((p) => p.dataKey === s.key)?.value;
                return (
                  <p key={s.key} className="flex items-center gap-2">
                    <Swatch color={s.color} dashed={s.dashed} />
                    <span className="flex-1 text-muted-foreground">{s.label}</span>
                    <span className="font-medium">{typeof v === "number" ? format(v) : "–"}</span>
                  </p>
                );
              })}
            </div>
          ) : null
        }
      />
    </>
  );

  return (
    <div>
      {series.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <Swatch color={s.color} dashed={s.dashed} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        {kind === "bars" ? (
          <BarChart
            data={data}
            margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
            barCategoryGap={1}
          >
            {common}
            {series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                stackId="a"
                fill={s.color}
                isAnimationActive={false}
                radius={i === series.length - 1 ? [2, 2, 0, 0] : 0}
              />
            ))}
          </BarChart>
        ) : (
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            {common}
            {series.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                type="linear"
                stroke={s.color}
                strokeWidth={2}
                strokeDasharray={s.dashed ? "4 3" : undefined}
                dot={{ r: 2, strokeWidth: 0, fill: s.color }}
                activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function Swatch({ color, dashed }: { color: string; dashed?: boolean }) {
  return dashed ? (
    <span className="inline-block w-3 border-t-2 border-dashed" style={{ borderColor: color }} />
  ) : (
    <span className="inline-block size-2.5 rounded-[2px]" style={{ background: color }} />
  );
}
