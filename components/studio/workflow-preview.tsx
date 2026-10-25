"use client";
import { useEffect, useMemo, useRef } from "react";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AgentGlyph,
  DirectorGlyph,
  ReferenceGlyph,
  ScriptGlyph,
} from "./studio-icons";
import type { StudioProject } from "@/lib/studio/schema";
type PreviewData = {
  name: string;
  subtitle: string;
  asset?: string;
  kind: string;
  [key: string]: unknown;
};
function PreviewNode({ data }: NodeProps<Node<PreviewData>>) {
  return (
    <div className="studio-preview-node">
      <Handle type="target" position={Position.Left} />
      {data.asset ? (
        <img src={`/api/assets/${data.asset}`} alt={data.name} />
      ) : (
        <div className="studio-preview-node-icon">
          {data.kind === "script" ? (
            <ScriptGlyph size={22} />
          ) : data.kind === "reference" ? (
            <ReferenceGlyph size={22} />
          ) : (
            <DirectorGlyph size={22} />
          )}
        </div>
      )}
      <div>
        <span>{data.subtitle}</span>
        <strong>{data.name}</strong>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { preview: PreviewNode };
export function WorkflowPreview({
  project: p,
  onOpen,
}: {
  project: StudioProject;
  onOpen: () => void;
}) {
  const instance = useRef<ReactFlowInstance<
    Node<PreviewData>,
    { id: string; source: string; target: string }
  > | null>(null);
  const { nodes, edges } = useMemo(() => {
    const nodes: Node<PreviewData>[] = [],
      edges: Array<{ id: string; source: string; target: string }> = [];
    const add = (
      id: string,
      x: number,
      y: number,
      name: string,
      subtitle: string,
      kind: string,
      asset?: string,
    ) =>
      nodes.push({
        id,
        position: { x, y },
        type: "preview",
        data: { name, subtitle, kind, asset },
      });
    const link = (source: string, target: string) =>
      edges.push({ id: `${source}-${target}`, source, target });
    add("script", 0, 80, "导演脚本", "01 / SCRIPT", "script");
    p.references.forEach((r, i) => {
      add(r.id, 255, i * 120, r.name, `@${r.id}`, "reference", r.assetName);
      link("script", r.id);
    });
    p.shots.forEach((s, i) => {
      add(
        s.id,
        510,
        i * 150,
        s.title,
        `${s.id} / ${s.duration} SEC`,
        "shot",
        s.imageAsset,
      );
      s.refs.forEach((id) => link(id, s.id));
      add(
        `v-${s.id}`,
        765,
        i * 150,
        s.videoAsset ? "视频已生成" : s.taskId ? "视频制作中" : "等待生成视频",
        s.id + " / VIDEO",
        "video",
        s.imageAsset,
      );
      link(s.id, `v-${s.id}`);
    });
    return { nodes, edges };
  }, [p.references, p.shots]);
  useEffect(() => {
    const timer = setTimeout(
      () => void instance.current?.fitView({ padding: 0.18, duration: 250 }),
      80,
    );
    return () => clearTimeout(timer);
  }, [nodes.length]);
  return (
    <div className="studio-workflow-preview">
      <div className="studio-workflow-preview-heading">
        <span>
          <AgentGlyph size={13} />
          实时工作流
        </span>
        <button onClick={onOpen}>展开画布 ↗</button>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onInit={(flow) => {
          instance.current = flow;
        }}
        onNodeDoubleClick={onOpen}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.15}
        maxZoom={1.2}
        panOnScroll
        preventScrolling={false}
        defaultEdgeOptions={{
          style: { stroke: "#b9a17a", strokeWidth: 1.5 },
          type: "smoothstep",
        }}
      >
        <Background gap={18} size={1} color="#ded6c7" />
      </ReactFlow>
      <span className="studio-preview-caption">
        脚本 → 固定参考 → 分镜 → 视频
      </span>
    </div>
  );
}
