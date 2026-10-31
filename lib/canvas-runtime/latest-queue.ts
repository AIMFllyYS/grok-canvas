/** 合并尚未开始的同键写入；读／清除是屏障，在途任务永不改写。 */
export function createLatestQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, { value: unknown; promise: Promise<void> }>();
  function append<T>(action: () => T | Promise<T>): Promise<T> {
    const result = tail.then(action);
    tail = result.catch(() => {});
    return result;
  }
  return {
    latest<T>(key: string, value: T, write: (value: T) => void | Promise<void>): Promise<void> {
      const existing = pending.get(key);
      if (existing) { existing.value = value; return existing.promise; }
      const entry = { value: value as unknown, promise: Promise.resolve() };
      entry.promise = append(async () => {
        if (pending.get(key) === entry) pending.delete(key);
        await write(entry.value as T);
      });
      pending.set(key, entry);
      return entry.promise;
    },
    barrier<T>(action: () => T | Promise<T>): Promise<T> {
      pending.clear();
      return append(action);
    },
  };
}
