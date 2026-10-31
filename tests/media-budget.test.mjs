import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// P4-03：共享媒体调度、缓存与播放器租约（可控 fetch/decode 计数）。
const loader = await loadTypescript("lib/media/loader.ts");
const leases = await loadTypescript("lib/media/player-leases.ts");
const cacheMod = await loadTypescript("lib/media/cache.ts");
after(async () => { await loader.dispose(); await leases.dispose(); await cacheMod.dispose(); });
const { createMediaLoader } = loader.module;
const { createPlayerLeases } = leases.module;
const { createMediaCache } = cacheMod.module;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async (n = 5) => { for (let i = 0; i < n; i++) await tick(); };

function harness(options = {}) {
  const pending = new Map();
  let disposed = 0, decodes = 0;
  const fetches = [];
  const timers = [];
  const media = createMediaLoader({
    fetch: (url, signal) => new Promise((resolve, reject) => {
      fetches.push(url);
      pending.set(url, resolve);
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
    decode: async (blob) => { decodes++; const id = `blob:${blob.size}-${decodes}`; return { url: id, width: 100, height: 100, bytes: blob.size, pixels: 10_000, dispose: () => { disposed++; } }; },
    schedule: (fn, ms) => timers.push({ fn, ms }),
    ...(options.cache ? { cache: options.cache } : {}),
  });
  const respond = (url, result = { status: "ok", blob: { size: 1000 } }) => { const resolve = pending.get(url); pending.delete(url); resolve?.(result); };
  return { media, fetches, respond, timers, counts: () => ({ disposed, decodes }) };
}

test("100 个同 key 订阅只下载一次；取消其中 99 个不影响最后 1 个；全部释放后才回收资源", async () => {
  const h = harness({ cache: createMediaCache({ bytes: 0, pixels: 0 }) });
  const subs = Array.from({ length: 100 }, () => { const c = new AbortController(); return { c, ...h.media.acquire("a", "/a", { signal: c.signal }) }; });
  await settle();
  assert.equal(h.fetches.length, 1);
  for (const s of subs.slice(0, 99)) { s.c.abort(); await s.promise.catch(() => {}); }
  h.respond("/a");
  const handle = await subs[99].promise;
  assert.equal(handle.url.startsWith("blob:"), true);
  assert.equal(h.counts().decodes, 1);
  assert.equal(h.counts().disposed, 0, "仍有订阅者时不回收");
  subs[99].release();
  subs[99].release();
  assert.equal(h.counts().disposed, 1, "最后一个释放后回收（幂等）");
});

test("全部订阅者在下载中取消：底层下载被取消，不解码", async () => {
  const h = harness();
  const a = h.media.acquire("x", "/x"), b = h.media.acquire("x", "/x");
  await settle();
  a.release(); b.release();
  await Promise.allSettled([a.promise, b.promise]);
  await settle();
  assert.equal(h.counts().decodes, 0);
  assert.equal(h.media.stats().jobs, 0);
});

test("网络并发 ≤6、解码并发 ≤2；空出的网络槽位先给高优先级", async () => {
  const pending = new Map();
  const order = [];
  const decodeGates = [];
  const media = createMediaLoader({
    fetch: (url) => new Promise(resolve => { order.push(url); pending.set(url, resolve); }),
    decode: () => new Promise(resolve => decodeGates.push(() => resolve({ url: "u", width: 1, height: 1, bytes: 1, pixels: 1, dispose() {} }))),
  });
  const handles = [];
  for (let i = 0; i < 10; i++) handles.push(media.acquire(`k${i}`, `/k${i}`, { priority: 2 }));
  handles.push(media.acquire("hot", "/hot", { priority: 0 }));
  await settle();
  assert.equal(media.stats().network, 6);
  assert.equal(order.length, 6);
  pending.get("/k0")({ status: "ok", blob: { size: 1 } });
  await settle();
  assert.equal(order[6], "/hot", "空出的槽位先给优先级 0");
  for (let round = 0; round < 20 && (pending.size || decodeGates.length); round++) {
    for (const url of [...order]) { const resolve = pending.get(url); if (resolve) { pending.delete(url); resolve({ status: "ok", blob: { size: 1 } }); } }
    await settle(3);
    assert.ok(media.stats().decoding <= 2);
    decodeGates.shift()?.();
    await settle(3);
  }
  assert.ok(media.stats().peak.network <= 6);
  assert.equal(media.stats().peak.decode, 2);
  for (const h of handles) h.release();
});

test("缓存：按字节/像素阈值驱逐无订阅条目并调用 dispose；有订阅的不驱逐；冷/热分别计数", async () => {
  const cache = createMediaCache({ bytes: 2500, pixels: 1e9 });
  const h = harness({ cache });
  const a = h.media.acquire("a", "/a"); await settle(); h.respond("/a"); await a.promise;
  const b = h.media.acquire("b", "/b"); await settle(); h.respond("/b"); await b.promise;
  a.release();
  const c = h.media.acquire("c", "/c"); await settle(); h.respond("/c"); await c.promise;
  assert.equal(cache.has("a"), false, "无订阅的 a 被驱逐");
  assert.equal(cache.has("b"), true);
  assert.equal(h.counts().disposed, 1);
  const warm = h.media.acquire("b", "/b");
  await warm.promise;
  assert.equal(h.media.stats().warmHits, 1);
  assert.equal(h.media.stats().coldLoads, 3);
  warm.release(); b.release(); c.release();
});

test("派生图未就绪（202）按 Retry-After 延迟重试，超过次数报失败而不是无限循环；失败后可重新请求", async () => {
  const h = harness();
  const a = h.media.acquire("p", "/p");
  const outcome = a.promise.then(() => null, error => error);
  for (let i = 0; i < 20; i++) {
    await settle();
    h.respond("/p", { status: "pending", retryAfterMs: 1000 });
    await settle();
    const timer = h.timers.shift();
    if (!timer) break;
    assert.equal(timer.ms, 1000);
    timer.fn();
  }
  assert.match(String((await outcome)?.message), /长时间未就绪/);
  assert.ok(h.fetches.length <= 10);
  const again = h.media.acquire("p", "/p");
  await settle();
  h.respond("/p");
  assert.ok((await again.promise).url);
  again.release();
});

test("播放器租约：最多 2 个实例、1 个播放；第 3 个申请释放最旧的暂停实例；释放幂等", () => {
  const players = createPlayerLeases();
  const events = [];
  const cb = (name) => ({ evict: () => events.push(`evict:${name}`), pause: () => events.push(`pause:${name}`) });
  const a = players.acquire("a", cb("a"));
  const b = players.acquire("b", cb("b"));
  a.play();
  b.play();
  assert.deepEqual(events, ["pause:a"], "开始播放 b 时暂停 a");
  assert.deepEqual(players.stats(), { instances: 2, playing: 1, peak: { instances: 2, playing: 1 } });
  const c = players.acquire("c", cb("c"));
  assert.deepEqual(events, ["pause:a", "evict:a"], "释放最旧的暂停实例 a，不挂第三个");
  assert.equal(players.stats().instances, 2);
  assert.equal(a.active(), false);
  assert.equal(a.play(), false, "已被释放的租约不能播放");
  c.release(); c.release();
  b.release();
  assert.equal(players.stats().instances, 0);
  assert.ok(players.stats().peak.instances <= 2 && players.stats().peak.playing <= 1);
});
