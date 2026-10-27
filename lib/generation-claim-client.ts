export async function generationClaim(canvasId: string, nodeId: string, id: string, action: "claim" | "complete" | "unknown" | "acknowledge"): Promise<void> {
  const response = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/generation-claim`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodeId, id, action }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? "生成任务状态更新失败");
}
