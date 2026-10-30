/**
 * 手势覆盖层（contracts.md C1 GestureState / C3）：只持有正在拖动或 resize 的参与节点的几何。
 * 正式文档在手势途中不变；React Flow 通过 scene-adapter 把覆盖层投影到参与节点上。
 * 不读取正文，不做全图遍历；update 只碰参与节点，没有变化时不通知。
 */
import type { Geometry } from "./types";

export type GestureKind = "drag" | "resize";
export type GestureParticipant = { id: string; geometry: Geometry };
export type GestureUpdate = { id: string; x?: number; y?: number; width?: number; height?: number };
export type GestureItem = { id: string; from: Geometry; to: Geometry };
export type GestureResult = { kind: GestureKind; items: GestureItem[] };

const same = (a: Geometry, b: Geometry) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const copy = (g: Geometry): Geometry => ({ x: g.x, y: g.y, width: g.width, height: g.height });

export function createGestureStore() {
  let kind: GestureKind | null = null;
  const start = new Map<string, Geometry>();
  const current = new Map<string, Geometry>();
  const finished = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;
  const stats = { updates: 0, notifications: 0 };

  const notify = () => {
    version++;
    stats.notifications++;
    for (const fn of [...listeners]) fn();
  };
  const reset = () => { kind = null; start.clear(); current.clear(); finished.clear(); };
  const include = (participants: readonly GestureParticipant[]) => {
    for (const { id, geometry } of participants) {
      if (start.has(id)) continue;
      start.set(id, copy(geometry));
      current.set(id, copy(geometry));
    }
  };
  const result = (): GestureItem[] => [...start].map(([id, from]) => ({ id, from: copy(from), to: copy(current.get(id)!) }));

  return {
    /** 开始一次手势；已有同类手势时把新参与者并入（框选拖动途中加入的节点）。 */
    begin(next: GestureKind, participants: readonly GestureParticipant[]) {
      if (kind && kind !== next) throw new Error(`已有进行中的 ${kind} 手势`);
      kind = next;
      include(participants);
      notify();
    },
    include(participants: readonly GestureParticipant[]) {
      if (!kind) throw new Error("没有进行中的手势");
      include(participants);
    },
    /** 只更新参与节点；返回覆盖层是否真的变化。 */
    update(items: readonly GestureUpdate[]): boolean {
      stats.updates++;
      let changed = false;
      for (const item of items) {
        const geometry = current.get(item.id);
        if (!geometry) continue;
        const next = {
          x: finite(item.x) ? item.x : geometry.x,
          y: finite(item.y) ? item.y : geometry.y,
          width: finite(item.width) && item.width > 0 ? item.width : geometry.width,
          height: finite(item.height) && item.height > 0 ? item.height : geometry.height,
        };
        if (same(next, geometry)) continue;
        current.set(item.id, next);
        changed = true;
      }
      if (changed) notify();
      return changed;
    },
    /** 标记某个参与者已松手；全部松手时返回 true。 */
    finish(id: string): boolean {
      if (start.has(id)) finished.add(id);
      return start.size > 0 && [...start.keys()].every(key => finished.has(key));
    },
    get: (id: string): Geometry | undefined => current.get(id),
    has: (id: string) => start.has(id),
    active: () => kind !== null,
    kind: () => kind,
    participants: (): string[] => [...start.keys()],
    /** 删除节点：退出手势、清掉锁；最后一个参与者离开时整个手势结束。 */
    drop(id: string) {
      if (!start.delete(id)) return;
      current.delete(id);
      finished.delete(id);
      if (!start.size) reset();
      notify();
    },
    /** 结束：只返回真正移动过的参与者；全部移回原点返回 null（无命令、无历史）。 */
    end(): GestureResult | null {
      if (!kind) return null;
      const ended = kind;
      const items = result().filter(item => !same(item.from, item.to));
      reset();
      notify();
      return items.length ? { kind: ended, items } : null;
    },
    /** 取消：丢弃覆盖层，参与节点回到正式文档中的位置。返回起点供调用方检查。 */
    cancel(): GestureItem[] {
      const items = [...start].map(([id, from]) => ({ id, from: copy(from), to: copy(from) }));
      if (kind) { reset(); notify(); }
      return items;
    },
    version: () => version,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    stats: () => ({ ...stats, participants: start.size }),
  };
}

export type GestureStore = ReturnType<typeof createGestureStore>;
