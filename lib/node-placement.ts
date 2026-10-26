/** Keep newly inserted cards clear of existing cards while staying near the requested point. */
export function placeNewNode(at: { x: number; y: number }, nodes: { position: { x: number; y: number }; measured?: { width?: number; height?: number } }[]) {
  for (let ring = 0; ring < 20; ring++) {
    const offsets = ring === 0 ? [[0, 0]] : [[ring * 320, 0], [0, ring * 280], [-ring * 320, 0], [0, -ring * 280], [ring * 320, ring * 280]];
    for (const [dx, dy] of offsets) {
      const point = { x: at.x + dx!, y: at.y + dy! };
      if (!nodes.some(n => point.x < n.position.x + (n.measured?.width ?? 280) + 24 && point.x + 304 > n.position.x && point.y < n.position.y + (n.measured?.height ?? 240) + 24 && point.y + 264 > n.position.y)) return point;
    }
  }
  return { x: at.x + 6400, y: at.y };
}
