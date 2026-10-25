import test, { after } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";
const loaded = await loadTypescript("lib/xai/usage.ts");
after(loaded.dispose);
const { parseUsage, createUsageReader, requestUsage } = loaded.module;
const json = percent => new Response(JSON.stringify({ config: { creditUsagePercent: percent } }));

test("真实适配器使用固定地址和CLI头，401仅刷新一次", async () => {
  const authPath = path.join(loaded.directory, "usage-auth.json");
  await writeFile(authPath, JSON.stringify({ tokens: { access_token: "old", refresh_token: "refresh", expires_in: 3600 }, last_refresh: new Date().toISOString(), session_id: "test-session" }));
  let requests = 0, refreshes = 0;
  const response = await requestUsage({ authPath, fetch: async (url, init) => {
    if (String(url).endsWith("/token")) { refreshes++; return new Response(JSON.stringify({ access_token: "new", refresh_token: "rotated", expires_in: 3600 })); }
    requests++;
    assert.equal(String(url), "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-xai-token-auth"), "xai-grok-cli");
    assert.equal(headers.get("Authorization"), requests === 1 ? "Bearer old" : "Bearer new");
    assert.equal(init.redirect, "error"); assert.ok(init.signal);
    return requests === 1 ? new Response("expired token", { status: 401 }) : json(30);
  } });
  assert.equal(response.status, 200); assert.equal(requests, 2); assert.equal(refreshes, 1);
});

test("用量0与100是合法值，未知不能变成0", () => {
  for (const usedPercent of [0, 12.5, 100]) assert.equal(parseUsage({ config: { creditUsagePercent: usedPercent } }, 0).usedPercent, usedPercent);
  for (const value of [undefined, null, "2", -1, 101, Infinity, NaN]) assert.throws(() => parseUsage({ config: { creditUsagePercent: value } }, 0));
  assert.throws(() => parseUsage({}, 0));
});
test("重置时间回退到合法字段", () => {
  const data = parseUsage({ config: { creditUsagePercent: 5, currentPeriod: { end: "bad" }, billingPeriodEnd: "2026-11-01T00:00:00Z" } }, 0);
  assert.equal(data.resetAt, "2026-11-01T00:00:00.000Z");
});
test("用量缓存60秒，合并同账户在途请求", async () => {
  let calls = 0, now = 0;
  const read = createUsageReader({ identity: async () => "a", now: () => now, request: async () => { calls++; return json(25); } });
  const values = await Promise.all([read(), read(), read()]);
  assert.equal(calls, 1);
  assert.equal(values[2].usedPercent, 25);
  now = 59_000; await read(); assert.equal(calls, 1);
  now = 61_000; await read(); assert.equal(calls, 2);
});
test("退出不能命中缓存，换账户不返回旧用量", async () => {
  let identity = "a";
  const read = createUsageReader({ identity: async () => identity, request: async () => json(identity === "a" ? 20 : 70) });
  assert.equal((await read()).usedPercent, 20);
  identity = null; await assert.rejects(read(), /登录/);
  identity = "b"; assert.equal((await read()).usedPercent, 70);
});
test("在途请求完成前换账户必须丢弃旧响应", async () => {
  let identity = "a", finish;
  const read = createUsageReader({ identity: async () => identity, request: () => new Promise(resolve => { finish = resolve; }) });
  const pending = read();
  await new Promise(resolve => setImmediate(resolve));
  identity = "b"; finish(json(15));
  await assert.rejects(pending, /账户/);
});
test("上游错误不能缓存为0或成功状态", async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    const read = createUsageReader({ identity: async () => "a", request: async () => { calls++; return new Response("error", { status }); } });
    await assert.rejects(read()); await assert.rejects(read()); assert.equal(calls, 2);
  }
  const read = createUsageReader({ identity: async () => "a", request: async () => new Response("not json") });
  await assert.rejects(read());
});
