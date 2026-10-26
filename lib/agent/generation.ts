import { clampVideoParameters, type VideoParameters } from "../video-request";
import { resolveCanvasReferences } from "../canvas-references";
import type { CanvasDoc } from "../canvas-store";
import type { CanvasNode, CanvasEdge } from "./canvas";
import { AgentError } from "./store";

/** Share the canvas video contract, especially first-frame aspect-ratio handling. */
export function canvasVideoBody(
  canvasId: string,
  node: CanvasNode,
  canvas: CanvasDoc,
) {
  const refs = resolveCanvasReferences(
    node,
    canvas.nodes as CanvasNode[],
    canvas.edges as CanvasEdge[],
  );
  if (refs.pending) throw new AgentError("参考图片尚未生成，请先完成来源节点");
  const parameters = clampVideoParameters(refs.inputs, {
    duration: (node.data.duration ?? 6) as VideoParameters["duration"],
    aspectRatio: (node.data.aspectRatio ??
      "16:9") as VideoParameters["aspectRatio"],
    resolution: (node.data.resolution ??
      "720p") as VideoParameters["resolution"],
    audio: node.data.audio === true,
  });
  return {
    canvasId,
    nodeId: node.id,
    prompt: node.data.prompt,
    inputs: refs.inputs,
    parameters,
  };
}
