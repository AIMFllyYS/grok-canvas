import test from "node:test";
import assert from "node:assert/strict";
import { createSoakSchedule, runSchedule } from "../scripts/performance/soak.mjs";

// P6-03：soak 调度器——固定种子可重复、每批 20、实体数有界、速率/停止/背压计数。

test("固定种子：同样的批次序列；每批 20 个操作；实体数不超过上限", () => {
  const a = createSoakSchedule({ seed: 7, maxEntities: 100 }), b = createSoakSchedule({ seed: 7, maxEntities: 100 });
  for (let i = 0; i < 200; i++) {
    const x = a.nextBatch(), y = b.nextBatch();
    assert.deepEqual(x, y);
    assert.equal(x.length, 20);
    assert.ok(a.live().length <= 100);
  }
  const stats = a.stats();
  assert.equal(stats.batches, 200);
  assert.ok(stats.add > 0 && stats.update > 0 && stats.remove > 0, JSON.stringify(stats));
  assert.notDeepEqual(createSoakSchedule({ seed: 8 }).nextBatch(), createSoakSchedule({ seed: 7 }).nextBatch());
});

test("同一批里不会对同一节点既删又改；删除的总是当前存在的最旧节点", () => {
  const s = createSoakSchedule({ seed: 3, maxEntities: 30 });
  const live = new Set();
  for (let i = 0; i < 100; i++) {
    const batch = s.nextBatch();
    const ids = batch.map(op => op.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const op of batch) {
      if (op.kind === "add") live.add(op.id);
      else { assert.ok(live.has(op.id), `${op.kind} 已存在的节点`); if (op.kind === "remove") live.delete(op.id); }
    }
  }
  assert.deepEqual([...live].sort(), s.live().sort());
});

test("速率与背压：2 批/秒；发送未完成时跳过本拍并计数；到时或 stop 后停止", async () => {
  let clock = 0;
  const timers = [];
  const setTimer = (fn, ms) => timers.push({ at: clock + ms, fn });
  const advance = async (ms) => {
    const end = clock + ms;
    while (timers.length) {
      timers.sort((a, b) => a.at - b.at);
      if (timers[0].at > end) break;
      const t = timers.shift(); clock = t.at; t.fn(); await Promise.resolve(); await Promise.resolve();
    }
    clock = end;
  };
  let release;
  const slow = new Promise(r => { release = r; });
  let calls = 0;
  const run = runSchedule(createSoakSchedule({ seed: 1 }), () => (++calls === 1 ? slow : Promise.resolve()), { batchesPerSecond: 2, durationMs: 5000, now: () => clock, setTimer });
  await advance(1600);
  assert.equal(calls, 1, "第一批未完成时不再发送");
  assert.ok(run.counters().skipped >= 3);
  release();
  await advance(4000);
  const result = await run.done;
  assert.ok(result.sent >= 5 && result.sent <= 10, JSON.stringify(result));
  assert.equal(result.failed, 0);
});
