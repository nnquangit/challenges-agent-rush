"use client";

import type { Artifact, ChartData, TableData } from "@/lib/types";

export default function ArtifactViewer({ artifacts }: { artifacts: Artifact[] }) {
  if (!artifacts.length) return <p className="px-1 py-3 text-sm text-zinc-500">No artifacts for this attempt.</p>;
  return (
    <div className="space-y-4">
      {artifacts.map((a) => (
        <figure key={a.id} className="overflow-hidden rounded-lg border border-line bg-black/30">
          <figcaption className="flex items-center justify-between border-b border-line px-3 py-1.5 font-mono text-[11px] text-zinc-400">
            <span>{a.name}</span>
            <span className="text-zinc-600">{a.mime}</span>
          </figcaption>
          <div className="p-3">
            <ArtifactBody a={a} />
          </div>
        </figure>
      ))}
    </div>
  );
}

function ArtifactBody({ a }: { a: Artifact }) {
  if (a.kind === "image")
    // data: URL fixture rendered by MockSandbox — not a remote image.
    return <img src={a.content} alt={`Sandbox screenshot fixture: ${a.name}`} className="w-full rounded border border-line" />;
  if (a.kind === "table" && a.data) return <Table data={a.data as TableData} />;
  if (a.kind === "chart" && a.data) return <BarChart data={a.data as ChartData} />;
  return <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-zinc-300">{a.content}</pre>;
}

function Table({ data }: { data: TableData }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-xs">
        <thead>
          <tr>
            {data.columns.map((c) => (
              <th key={c} className="border-b border-line px-2 py-1.5 text-left font-semibold text-zinc-400">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={i} className="odd:bg-white/[0.02]">
              {r.map((v, j) => (
                <td key={j} className={`px-2 py-1.5 ${typeof v === "number" ? "text-right tabular-nums text-zinc-200" : "text-zinc-300"}`}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BarChart({ data }: { data: ChartData }) {
  const max = Math.max(...data.points.map((p) => p.y), 1);
  return (
    <div>
      <p className="mb-2 font-mono text-[11px] text-zinc-500">{data.label}</p>
      <div className="space-y-1.5" role="img" aria-label={`Bar chart: ${data.label}`}>
        {data.points.map((p) => (
          <div key={p.x} className="grid grid-cols-[72px_1fr_64px] items-center gap-2 font-mono text-xs">
            <span className="truncate text-zinc-400">{p.x}</span>
            <span className="h-4 rounded-sm bg-gradient-to-r from-emerald-500/80 to-emerald-300/80" style={{ width: `${(p.y / max) * 100}%` }} />
            <span className="text-right tabular-nums text-zinc-300">{p.y}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
