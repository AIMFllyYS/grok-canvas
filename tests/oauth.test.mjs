import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-oauth-test-"));
after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(path.join(temporary, "package.json"), '{"type":"module"}');
for (const name of ["oauth", "store", "constants", "pkce", "client", "callback-headers"]) {
  const source = await readFile(new URL(`../lib/xai/${name}.ts`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  await writeFile(path.join(temporary, `${name}.js`), output.replace(/from "(\.\/[^".]+)"/g, 'from "$1.js"'));
}
const { beginLogin, completeLogin, refreshTokens } = await import(pathToFileURL(path.join(temporary, "oauth.js")));
const { loadAuth, saveAuth, emptyAuthFile } = await import(pathToFileURL(path.join(temporary, "store.js")));
const { authenticatedFetch } = await import(pathToFileURL(path.join(temporary, "client.js")));
const { callbackHeaders } = await import(pathToFileURL(path.join(temporary, "callback-headers.js")));
let serial = 0;
const authPath = () => path.join(temporary, `auth-${++serial}.json`);
const json = body => new Response(JSON.stringify(body));
const begin = file => beginLogin({ authPath: file, fetch: async () => new Response(null, { status: 503 }) });

test("manual completion binds the returned state to the saved PKCE verifier", async () => {
  const file = authPath();
  const login = await begin(file);
  const pending = (await loadAuth(file)).pending_oauth;
  assert.equal(new URL(login.authorizeUrl).searchParams.get("state"), login.state);
  await completeLogin({ authPath: file, code: "pasted-code", state: login.state, fetch: async (_, init) => {
    const form = new URLSearchParams(init.body);
    assert.equal(form.get("code"), "pasted-code");
    assert.equal(form.get("code_verifier"), pending.code_verifier);
    assert.equal(form.get("redirect_uri"), pending.redirect_uri);
    return json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
  } });
  const saved = await loadAuth(file);
  assert.equal(saved.tokens.access_token, "access");
  assert.equal(saved.pending_oauth, null);
  await assert.rejects(completeLogin({ authPath: file, code: "pasted-code", state: login.state }), { code: "no_pending_session" });
});

test("wrong state and expired sessions cannot exchange a code", async () => {
  const file = authPath();
  const login = await begin(file);
  const fetch = () => { throw new Error("must never exchange"); };
  await assert.rejects(completeLogin({ authPath: file, code: "code", state: "wrong", fetch }), { code: "state_mismatch" });
  const auth = await loadAuth(file);
  auth.pending_oauth.created_at = new Date(Date.now() - 11 * 60_000).toISOString();
  await saveAuth(auth, file);
  await assert.rejects(completeLogin({ authPath: file, code: "code", state: login.state, fetch }), { code: "session_expired" });
});

test("malformed token responses never persist a successful login", async () => {
  for (const tokens of [{ access_token: 123 }, { access_token: "   " }, { access_token: "ok", expires_in: -1 }]) {
    const file = authPath();
    const login = await begin(file);
    await assert.rejects(completeLogin({ authPath: file, state: login.state, code: "code", fetch: async () => json(tokens) }));
    assert.equal((await loadAuth(file)).tokens.access_token, undefined);
  }
});

test("a new login does not retain a previous account refresh token or profile", async () => {
  const file = authPath();
  const auth = emptyAuthFile();
  auth.tokens = { access_token: "old", refresh_token: "old-refresh" };
  auth.profile = { email: "old@example.com" };
  await saveAuth(auth, file);
  const login = await begin(file);
  await completeLogin({ authPath: file, state: login.state, code: "code", fetch: async () => json({ access_token: "new" }) });
  const saved = await loadAuth(file);
  assert.equal(saved.tokens.refresh_token, null);
  assert.equal(saved.profile, null);
});

test("near-expiry requests share a single proactive refresh", async () => {
  const file = authPath();
  const auth = emptyAuthFile();
  auth.tokens = { access_token: "old", refresh_token: "refresh", expires_in: 3600 };
  auth.last_refresh = new Date(Date.now() - 3590_000).toISOString();
  await saveAuth(auth, file);
  let refreshes = 0;
  const fetch = async (url, init) => {
    if (String(url).endsWith("/token")) {
      refreshes++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return json({ access_token: "new", expires_in: 3600 });
    }
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer new");
    return json({ ok: true });
  };
  await Promise.all([authenticatedFetch("https://api.x.ai/v1/test", {}, { authPath: file, fetch }), authenticatedFetch("https://api.x.ai/v1/test", {}, { authPath: file, fetch })]);
  assert.equal(refreshes, 1);
  assert.equal((await loadAuth(file)).tokens.refresh_token, "refresh");
});

test("登录保留头像并为新会话分配独立标识", async () => {
  const file = authPath();
  const login = await begin(file);
  const claims = Buffer.from(JSON.stringify({ email: "a@example.com", sub: "a", picture: "https://example.com/a.png" })).toString("base64url");
  await completeLogin({ authPath: file, state: login.state, code: "code", fetch: async () => json({ access_token: "a", refresh_token: "r", id_token: `header.${claims}.signature` }) });
  const saved = await loadAuth(file);
  assert.equal(saved.profile.picture, "https://example.com/a.png");
  assert.equal(typeof saved.session_id, "string");
  await refreshTokens({ authPath: file, fetch: async () => json({ access_token: "b", refresh_token: "r2" }) });
  assert.equal((await loadAuth(file)).session_id, saved.session_id);
});

test("退出之后在途刷新不能恢复已清除的凭据", async () => {
  const file = authPath();
  const auth = emptyAuthFile(); auth.tokens = { access_token: "a", refresh_token: "r" }; auth.session_id = "old";
  await saveAuth(auth, file);
  await assert.rejects(refreshTokens({ authPath: file, fetch: async () => {
    const current = await loadAuth(file); current.tokens = {}; delete current.session_id; await saveAuth(current, file);
    return json({ access_token: "late", refresh_token: "late-refresh" });
  } }));
  assert.equal((await loadAuth(file)).tokens.access_token, undefined);
});

test("callback CORS allows only the official accounts origin", () => {
  const allowed = callbackHeaders("https://accounts.x.ai");
  assert.equal(allowed.get("Access-Control-Allow-Origin"), "https://accounts.x.ai");
  assert.equal(allowed.get("Access-Control-Allow-Private-Network"), "true");
  for (const origin of [null, "https://evil.example", "https://accounts.x.ai.evil.example"]) {
    assert.equal(callbackHeaders(origin).get("Access-Control-Allow-Origin"), null);
  }
});

test("credential replacements are private and leave no temporary files", async () => {
  const dir = path.join(temporary, "private");
  await mkdir(dir);
  const file = path.join(dir, "auth.json");
  await writeFile(file, "{}", { mode: 0o644 });
  await saveAuth(emptyAuthFile(), file);
  // Windows 的 stat.mode 不表达 ACL，POSIX 权限位只在支持的平台验证。
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 1);
  assert.deepEqual(await readdir(dir), ["auth.json"]);
});

test("an in-flight exchange cannot restore a cancelled login", async () => {
  const file = authPath();
  const login = await begin(file);
  await assert.rejects(completeLogin({ authPath: file, state: login.state, code: "code", fetch: async () => {
    const current = await loadAuth(file);
    current.pending_oauth = null;
    await saveAuth(current, file);
    return json({ access_token: "late-token" });
  } }), { code: "no_pending_session" });
  assert.equal((await loadAuth(file)).tokens.access_token, undefined);
});

const nextServer = import.meta.resolve("next/server.js");
const routeSource = await readFile(new URL("../app/callback/route.ts", import.meta.url), "utf8");
const routeOutput = ts.transpileModule(routeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replaceAll('"next/server"', JSON.stringify(nextServer))
  .replaceAll('"@/lib/xai/oauth"', '"./oauth.js"')
  .replaceAll('"@/lib/xai/store"', '"./store.js"')
  .replaceAll('"@/lib/xai/callback-headers"', '"./callback-headers.js"');
await writeFile(path.join(temporary, "callback.js"), routeOutput);
const callback = await import(pathToFileURL(path.join(temporary, "callback.js")));

test("callback route handles private-network preflight and rejects untrusted origins", async () => {
  const response = callback.OPTIONS(new Request("http://127.0.0.1:3210/callback", { method: "OPTIONS", headers: { origin: "https://accounts.x.ai", "access-control-request-method": "GET", "access-control-request-private-network": "true" } }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Private-Network"), "true");
  const denied = await callback.GET(new Request("http://127.0.0.1:3210/callback?code=abc", { headers: { origin: "https://evil.example" } }));
  assert.equal(denied.status, 403);
});

test("fetch callbacks return CORS results while navigation gets a clean result URL", async () => {
  const previousAuthPath = process.env.GROK_CANVAS_AUTH_PATH;
  process.env.GROK_CANVAS_AUTH_PATH = authPath();
  const url = "http://127.0.0.1:3210/callback?error=access_denied&error_description=private-detail";
  const response = await callback.GET(new Request(url, { headers: { origin: "https://accounts.x.ai" } }));
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://accounts.x.ai");
  assert.deepEqual(await response.json(), { ok: false, result: "denied" });
  const navigation = await callback.GET(new Request(url));
  assert.equal(navigation.headers.get("location"), "http://127.0.0.1:3210/auth-result?auth=denied");
  if (previousAuthPath === undefined) delete process.env.GROK_CANVAS_AUTH_PATH;
  else process.env.GROK_CANVAS_AUTH_PATH = previousAuthPath;
});
