/**
 * 渲染、媒体与后台预算的唯一来源（contracts.md C7）。P4/P5/P6 的投影、媒体调度与采样都从这里读取，
 * 不在各处重复写常量。
 */
export const RUNTIME_BUDGET = Object.freeze({
  /** 完整组件上限 / 轻量目标。 */
  fullComponents: 80,
  lightComponents: 400,
  /** 进入概览：zoom < 0.30 或候选 > 500；退出：zoom > 0.38 且候选 < 350（滞回）。 */
  overviewEnterZoom: 0.3,
  overviewEnterCandidates: 500,
  overviewExitZoom: 0.38,
  overviewExitCandidates: 350,
  /** 视口外预取带（屏幕像素）。 */
  prefetchBandPx: 300,
  /** 后台工作每片最多占用主线程的毫秒数。 */
  backgroundSliceMs: 4,
  /** 预显示合并窗口。 */
  previewMergeMs: 100,
  /** 预显示队列容量：条数与字节。 */
  previewQueueItems: 500,
  previewQueueBytes: 2 * 1024 * 1024,
  /** 媒体并发：网络、解码、播放器、主动播放。 */
  networkConcurrency: 6,
  decodeConcurrency: 2,
  players: 2,
  activePlayback: 1,
  /** 应用解码缓存 LRU：字节与像素。 */
  decodeCacheBytes: 128 * 1024 * 1024,
  decodeCachePixels: 32_000_000,
});

/** 调度优先级：数值越小越先执行（gesture > receipt/terminal > visible-content > preview > prefetch/maintenance）。 */
export const PRIORITY = Object.freeze({ gesture: 0, terminal: 1, visible: 2, preview: 3, prefetch: 4, maintenance: 5 } as const);
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];
