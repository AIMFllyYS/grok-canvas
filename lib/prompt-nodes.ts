type PromptNode = { id: string; type?: string; data: Record<string, unknown> };
type PromptEdge = { source: string; target: string; data?: Record<string, unknown> };
export function isPromptNode(node: PromptNode | undefined) { return node?.type === "text" || node?.type === "prompt"; }
/** Resolve only direct parameter inputs in edge order; cycles cannot recurse. Retry snapshots bypass this. */
export function resolveNodePrompt(nodeId: string, own: string, nodes: PromptNode[], edges: PromptEdge[]) {
  const inputs = edges.filter(e => e.target === nodeId).map(e => nodes.find(n => n.id === e.source)).filter(isPromptNode).map(n => String(n!.data.text ?? "").trim()).filter(Boolean);
  return [...inputs, own.trim()].filter(Boolean).join("\n\n");
}
