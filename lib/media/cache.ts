/**
 * 媒体缓存（P4-03）：按字节（默认 128MiB）与像素（默认 3200 万）双阈值做 LRU。
 * 只驱逐没有订阅者的条目；驱逐调用条目自己的 dispose（revokeObjectURL / ImageBitmap.close），不是只删 Map。
 * 这是应用层预算，不代表浏览器进程的绝对内存上限。
 */
export type CacheEntry<T> = { value: T; bytes: number; pixels: number; dispose: () => void };

export const CACHE_LIMITS = { bytes: 128 * 1024 * 1024, pixels: 32_000_000 };

export function createMediaCache<T>(limits = CACHE_LIMITS) {
  const entries = new Map<string, CacheEntry<T> & { refs: number }>();
  let bytes = 0, pixels = 0, hits = 0, misses = 0, evictions = 0;

  function evict() {
    if (bytes <= limits.bytes && pixels <= limits.pixels) return;
    // Map 迭代顺序即最近使用顺序（get/put 时重新插入）。
    for (const [key, entry] of entries) {
      if (bytes <= limits.bytes && pixels <= limits.pixels) break;
      if (entry.refs > 0) continue;
      entries.delete(key);
      bytes -= entry.bytes; pixels -= entry.pixels; evictions++;
      try { entry.dispose(); } catch { /* 已释放 */ }
    }
  }
  const touch = (key: string, entry: CacheEntry<T> & { refs: number }) => { entries.delete(key); entries.set(key, entry); };

  return {
    /** 命中则加一个引用并返回值。 */
    retain(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry) { misses++; return undefined; }
      hits++;
      entry.refs++;
      touch(key, entry);
      return entry.value;
    },
    /** 放入并持有一个引用。 */
    put(key: string, entry: CacheEntry<T>) {
      const old = entries.get(key);
      if (old) { bytes -= old.bytes; pixels -= old.pixels; try { old.dispose(); } catch { /* */ } }
      entries.set(key, { ...entry, refs: 1 });
      bytes += entry.bytes; pixels += entry.pixels;
      evict();
    },
    release(key: string) {
      const entry = entries.get(key);
      if (!entry) return;
      entry.refs = Math.max(0, entry.refs - 1);
      if (!entry.refs) evict();
    },
    has: (key: string) => entries.has(key),
    clear() {
      for (const [key, entry] of entries) {
        if (entry.refs > 0) continue;
        entries.delete(key); bytes -= entry.bytes; pixels -= entry.pixels;
        try { entry.dispose(); } catch { /* */ }
      }
    },
    stats: () => ({ entries: entries.size, bytes, pixels, hits, misses, evictions, referenced: [...entries.values()].filter(e => e.refs > 0).length }),
  };
}
