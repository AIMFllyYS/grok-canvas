/** 与 lib/canvas-runtime/metrics.ts 相同的最近秩百分位（脚本侧无需加载 TypeScript）。 */
export function percentile(sorted, p) {
  if (!sorted.length) throw new Error("空样本没有百分位");
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}
