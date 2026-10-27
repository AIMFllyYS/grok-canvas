/** Keep newly inserted cards clear of existing cards while staying near the requested point. */
export function placeNewNode(at: { x: number; y: number }, nodes: { position: { x: number; y: number }; width?: number; height?: number; measured?: { width?: number; height?: number } }[], size = { width: 304, height: 264 }) {
  for (let ring = 0; ring < 20; ring++) {
    const offsets = ring === 0 ? [[0, 0]] : [[ring * 320, 0], [0, ring * 280], [-ring * 320, 0], [0, -ring * 280], [ring * 320, ring * 280]];
    for (const [dx, dy] of offsets) {
      const point = { x: at.x + dx!, y: at.y + dy! };
      if (!nodes.some(n => point.x < n.position.x + (n.width ?? n.measured?.width ?? 280) + 24 && point.x + size.width + 24 > n.position.x && point.y < n.position.y + (n.height ?? n.measured?.height ?? 240) + 24 && point.y + size.height + 24 > n.position.y)) return point;
    }
  }
  return { x: Math.max(at.x, ...nodes.map(n => n.position.x + (n.width ?? n.measured?.width ?? 280) + 24)), y: at.y };
}
