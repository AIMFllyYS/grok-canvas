/**
 * 进程内画布变更通知（P3-09）。命令提交、服务端写入与旧整图保存成功后调用 notify，
 * SSE 事件流据此立即推送新修订；漏掉的写入由事件流的低频修订探测兜底。
 * 只传 ID/修订/actor，不携带实体数据；监听器异常不影响写入方。
 */
export type CanvasChange = { canvasId: string; revision: number | null; actorId: string | null };
type Listener = (change: CanvasChange) => void;

const KEY = "__grokCanvasChangeBus";
type Holder = { [KEY]?: Map<string, Set<Listener>> };

// Next 会把不同路由打成独立模块：挂在 globalThis 上保证同一进程只有一份订阅表。
function listeners(): Map<string, Set<Listener>> {
  const holder = globalThis as Holder;
  return (holder[KEY] ??= new Map());
}

export function notifyCanvasChanged(change: CanvasChange): void {
  const set = listeners().get(change.canvasId);
  if (!set) return;
  for (const listener of [...set]) {
    try { listener(change); } catch { /* 订阅方自行处理错误 */ }
  }
}

export function subscribeCanvasChanged(canvasId: string, listener: Listener): () => void {
  const map = listeners();
  let set = map.get(canvasId);
  if (!set) { set = new Set(); map.set(canvasId, set); }
  set.add(listener);
  return () => {
    const current = map.get(canvasId);
    if (!current) return;
    current.delete(listener);
    if (!current.size) map.delete(canvasId);
  };
}

/** 测试/诊断：某画布（或全部）当前订阅数，用于验证切换画布后连接回到常数。 */
export function changeListenerCount(canvasId?: string): number {
  const map = listeners();
  if (canvasId !== undefined) return map.get(canvasId)?.size ?? 0;
  let total = 0;
  for (const set of map.values()) total += set.size;
  return total;
}
