"use client";
import { useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, useNodesState, type Node } from "@xyflow/react";
import { WorkspacePreferencesProvider } from "@/components/workspace-preferences";
import { AuthProvider } from "@/components/auth-status";
import { TextNode } from "@/components/canvas/text-node";
import { WorkflowNode } from "@/components/canvas/workflow-node";
import { ImageNode, defaultImageNodeData } from "@/components/canvas/image-node";
import { VideoNode, defaultVideoNodeData } from "@/components/canvas/video-node";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
const types = { text: TextNode, prompt: TextNode, workflow: WorkflowNode, image: ImageNode, video: VideoNode };
export function NodeGallery({ fixtures }: { fixtures: Node[] }) {
  return <WorkspacePreferencesProvider><AuthProvider><ReactFlowProvider><Gallery fixtures={fixtures}/></ReactFlowProvider></AuthProvider></WorkspacePreferencesProvider>;
}
function Gallery({ fixtures }: { fixtures: Node[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([...fixtures,
    { id: "image", type: "image", position: { x: 700, y: 0 }, data: defaultImageNodeData("参考图片") },
    { id: "video", type: "video", position: { x: 350, y: 300 }, data: defaultVideoNodeData("MP4 视频") },
  ]);
  const [mode, setMode] = useState<"select" | "hand">("select"), [minimap, setMinimap] = useState(false);
  const add = (type: "text" | "prompt" | "image" | "video") => setNodes(items => [...items, { id: crypto.randomUUID(), type, position: { x: 40 + items.length * 32, y: 40 + items.length * 24 }, data: type === "image" ? defaultImageNodeData("图片") : type === "video" ? defaultVideoNodeData("视频") : { name: type === "text" ? "文本笔记" : "提示词参数", text: "共享组件预览。" } }]);
  return <div className="pre-spec-canvas" ref={container} style={{position:"relative"}}><ReactFlow nodes={nodes} onNodesChange={onNodesChange} nodeTypes={types} fitView minZoom={.2} panOnDrag={mode === "hand"} selectionOnDrag={mode === "select"} proOptions={{hideAttribution:true}}><Background gap={24} size={1}/></ReactFlow><CanvasToolbar canvasId="playbook" containerRef={container} mode={mode} onModeChange={setMode} minimapOpen={minimap} onToggleMinimap={()=>setMinimap(!minimap)} onAddImage={()=>add("image")} onAddVideo={()=>add("video")} onAddText={add} onDraggingChange={()=>{}}/></div>;
}
