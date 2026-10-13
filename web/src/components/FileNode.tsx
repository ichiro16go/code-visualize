import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import type { FlowNode } from "../graph.ts";

const hidden = { opacity: 0, width: 6, height: 6, minWidth: 0, minHeight: 0, border: 0 } as const;

export const FileNode = memo(function FileNode({ data }: NodeProps<FlowNode>) {
  const cls = ["node", data.kind, data.dim ? "dim" : "", data.highlight ? "highlight" : ""].join(" ");
  return (
    <div className={cls} style={{ "--node-color": data.color } as React.CSSProperties} title={data.path || data.label}>
      {/* 既定のハンドル (左=入力, 右=出力) と、読む順番ビューの折り返し用ハンドル */}
      <Handle type="target" position={Position.Left} style={hidden} />
      <Handle type="source" position={Position.Right} style={hidden} />
      <Handle id="t" type="target" position={Position.Top} style={hidden} />
      <Handle id="b" type="source" position={Position.Bottom} style={hidden} />
      <Handle id="rt" type="target" position={Position.Right} style={hidden} />
      <Handle id="ls" type="source" position={Position.Left} style={hidden} />
      <span className="node-bar" />
      <span className="node-body">
        <span className="node-label">
          {data.kind === "folder" && <span className="node-caret">{data.collapsed ? "▸" : "▾"}</span>}
          {data.label}
        </span>
        {data.sub && <span className="node-sub">{data.sub}</span>}
      </span>
      {data.badge && (
        <span className="node-badge" style={data.badgeColor ? { background: data.badgeColor } : undefined}>
          {data.badge}
        </span>
      )}
    </div>
  );
});

export const nodeTypes = { file: FileNode };
