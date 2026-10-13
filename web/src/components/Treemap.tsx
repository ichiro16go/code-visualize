// 複雑度マップ: 面積 = 行数、色 = 選択した指標 のツリーマップ

import { useEffect, useMemo, useRef, useState } from "react";
import type { Analysis, FileInfo } from "../../../shared/types.ts";

type ColorMetric = "complexity" | "density" | "findings";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Item<T> {
  value: number;
  item: T;
}

/** squarified treemap のレイアウト */
function squarify<T>(items: Item<T>[], rect: Rect): Array<Rect & { item: T }> {
  const out: Array<Rect & { item: T }> = [];
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!total || rect.w <= 0 || rect.h <= 0) return out;
  const scale = (rect.w * rect.h) / total;
  const queue = [...items].sort((a, b) => b.value - a.value).map((i) => ({ ...i, area: i.value * scale }));
  let r = { ...rect };

  const worst = (row: typeof queue, side: number) => {
    const s = row.reduce((a, b) => a + b.area, 0);
    const max = Math.max(...row.map((x) => x.area));
    const min = Math.min(...row.map((x) => x.area));
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };

  while (queue.length) {
    const side = Math.min(r.w, r.h);
    const row = [queue.shift()!];
    while (queue.length && worst([...row, queue[0]], side) <= worst(row, side)) row.push(queue.shift()!);
    const sum = row.reduce((a, b) => a + b.area, 0);
    if (r.w >= r.h) {
      const w = sum / r.h;
      let y = r.y;
      for (const it of row) {
        const h = it.area / w;
        out.push({ x: r.x, y, w, h, item: it.item });
        y += h;
      }
      r = { x: r.x + w, y: r.y, w: r.w - w, h: r.h };
    } else {
      const h = sum / r.w;
      let x = r.x;
      for (const it of row) {
        const w = it.area / h;
        out.push({ x, y: r.y, w, h, item: it.item });
        x += w;
      }
      r = { x: r.x, y: r.y + h, w: r.w, h: r.h - h };
    }
  }
  return out;
}

function heat(t: number): string {
  // 0 (緑) → 0.5 (黄) → 1 (赤)
  const clamp = Math.max(0, Math.min(1, t));
  const hue = 130 - clamp * 130;
  return `hsl(${hue} 65% 48%)`;
}

export function Treemap({ analysis, selected, onSelect }: { analysis: Analysis; selected: string | null; onSelect: (p: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [metric, setMetric] = useState<ColorMetric>("complexity");
  const [hover, setHover] = useState<FileInfo | null>(null);
  const [hideTests, setHideTests] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const findingsByFile = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of analysis.findings) m.set(f.file, (m.get(f.file) ?? 0) + 1);
    return m;
  }, [analysis]);

  const files = useMemo(
    () => analysis.files.filter((f) => f.lines > 0 && f.role !== "doc" && !(hideTests && f.role === "test")),
    [analysis, hideTests],
  );

  const valueOf = (f: FileInfo): number => {
    if (metric === "complexity") return f.complexity;
    if (metric === "density") return f.lines ? (f.complexity / f.lines) * 100 : 0;
    return findingsByFile.get(f.path) ?? 0;
  };

  const maxValue = useMemo(() => {
    const vals = files.map(valueOf).sort((a, b) => a - b);
    // 外れ値に引っ張られないよう 95 パーセンタイルを上限にする
    return Math.max(1, vals[Math.floor(vals.length * 0.95)] ?? 1);
  }, [files, metric, findingsByFile]);

  const groups = useMemo(() => {
    const byTop = new Map<string, FileInfo[]>();
    for (const f of files) {
      const top = f.path.includes("/") ? f.path.split("/")[0] : "(ルート)";
      byTop.set(top, [...(byTop.get(top) ?? []), f]);
    }
    const outer = squarify(
      [...byTop.entries()].map(([name, fs]) => ({ value: fs.reduce((s, f) => s + f.lines, 0), item: { name, files: fs } })),
      { x: 0, y: 0, w: size.w, h: size.h },
    );
    return outer.map((g) => {
      const pad = { x: g.x + 2, y: g.y + 18, w: g.w - 4, h: g.h - 20 };
      return { ...g, cells: squarify(g.item.files.map((f) => ({ value: f.lines, item: f })), pad) };
    });
  }, [files, size]);

  return (
    <div className="treemap-wrap">
      <div className="treemap-toolbar">
        <span>面積 = 行数 / 色 =</span>
        {(
          [
            ["complexity", "複雑度 (分岐の数)"],
            ["density", "複雑さの密度 (100行あたり)"],
            ["findings", "セキュリティ検出数"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={`chip ${metric === id ? "active" : ""}`} onClick={() => setMetric(id)}>
            {label}
          </button>
        ))}
        <label className="small">
          <input type="checkbox" checked={hideTests} onChange={(e) => setHideTests(e.target.checked)} /> テストを除く
        </label>
        <span className="legend-heat">
          低 <span className="heat-bar" /> 高
        </span>
      </div>
      <div className="treemap" ref={ref} onMouseLeave={() => setHover(null)}>
        {groups.map((g) => (
          <div key={g.item.name} className="tm-group" style={{ left: g.x, top: g.y, width: g.w, height: g.h }}>
            <div className="tm-group-label">{g.item.name}</div>
          </div>
        ))}
        {groups.flatMap((g) =>
          g.cells.map((c) => (
            <div
              key={c.item.path}
              className={`tm-cell ${selected === c.item.path ? "selected" : ""}`}
              style={{ left: c.x, top: c.y, width: Math.max(0, c.w - 1), height: Math.max(0, c.h - 1), background: heat(valueOf(c.item) / maxValue) }}
              onClick={() => onSelect(c.item.path)}
              onMouseEnter={() => setHover(c.item)}
            >
              {c.w > 60 && c.h > 22 && <span>{c.item.path.split("/").pop()}</span>}
            </div>
          )),
        )}
        {hover && (
          <div className="tm-tooltip">
            <strong>{hover.path}</strong>
            <div>
              {hover.lines} 行 · 関数 {hover.functions} · 複雑度 {hover.complexity} · 検出 {findingsByFile.get(hover.path) ?? 0}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
