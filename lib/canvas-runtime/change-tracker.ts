type Change = { type: string; id?: string; position?: unknown; dragging?: boolean; resizing?: boolean; setAttributes?: boolean | "width" | "height" };

/** 只消费变更元数据；不持有节点正文，也不读取全图。 */
export function createChangeTracker() {
  const gestures = new Set<string>();
  let persist = false;
  let assets = false;
  return {
    begin: (kind: string) => { gestures.add(kind); },
    end: (kind: string) => { gestures.delete(kind); },
    reset: () => { gestures.clear(); },
    active: () => gestures.size > 0,
    dirty: () => persist,
    mutate(withAssets = true) { persist = true; assets ||= withAssets; },
    nodes(changes: Change[]) {
      for (const change of changes) {
        if (change.type === "select") continue;
        if (change.type === "dimensions") {
          const key = `resize:${change.id ?? ""}`;
          if (change.resizing === true) gestures.add(key);
          if (change.resizing === false) gestures.delete(key);
          if (change.setAttributes) persist = true;
        } else if (change.type === "position") {
          const key = `drag:${change.id ?? ""}`;
          if (change.dragging === true) gestures.add(key);
          if (change.dragging === false) gestures.delete(key);
          if (change.position) persist = true;
        } else {
          if (change.type === "remove") { gestures.delete(`drag:${change.id ?? ""}`); gestures.delete(`resize:${change.id ?? ""}`); }
          persist = true;
          assets ||= change.type === "add" || change.type === "replace";
        }
      }
    },
    edges(changes: Change[]) { if (changes.some(change => change.type !== "select")) persist = true; },
    take(): { persist: true; assets: boolean } | null {
      if (gestures.size || !persist) return null;
      const result = { persist: true as const, assets };
      persist = assets = false;
      return result;
    },
  };
}

/** 每个异步边界后重新检查，避免在等待网络／草稿期间开始的新手势被远端结果打断。 */
export async function waitForGestureIdle(
  tracker: { active(): boolean },
  mounted: () => boolean,
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 25)),
): Promise<boolean> {
  while (mounted() && tracker.active()) await pause();
  return mounted();
}

/** effect 的 dirty 计数可能晚于回执；未提交变更必须继续留在下一批。 */
export function versionAfterCommit(sent: number, current: number, pending: boolean): number {
  return pending && current === sent ? current + 1 : current;
}
