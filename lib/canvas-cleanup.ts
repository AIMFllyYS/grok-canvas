import type { CanvasDoc } from "./canvas-store";
/** Remove retired node records and dangling links while preserving image/video assets. */
export function cleanCanvas(doc: CanvasDoc): CanvasDoc {
  const nodes = (
    doc.nodes as { id: string; type?: string; data?: Record<string, unknown> }[]
  )
    .filter((n) => !["workflow", "text", "prompt"].includes(n.type ?? ""))
    .map((n) => {
      if (!n.data?.studioProjectId) return n;
      const { studioProjectId: _old, ...data } = n.data;
      return { ...n, data };
    });
  const ids = new Set(nodes.map((n) => n.id));
  return {
    ...doc,
    nodes,
    edges: (
      doc.edges as {
        source: string;
        target: string;
        data?: Record<string, unknown>;
      }[]
    ).filter(
      (e) => ids.has(e.source) && ids.has(e.target) && !e.data?.studioControl,
    ),
  };
}
