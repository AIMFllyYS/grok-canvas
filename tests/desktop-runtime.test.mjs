import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const runtime = require("../desktop/runtime.cjs");

test("packaged desktop runs the standalone server from resources/app", () => {
  const launch = runtime.serverLaunch({
    packaged: true,
    resourcesPath: path.resolve("C:/Grok Canvas/resources"),
    appPath: path.resolve("C:/Grok Canvas/resources/app.asar"),
  });

  assert.equal(launch.cwd, path.join(path.resolve("C:/Grok Canvas/resources"), "app"));
  assert.equal(launch.entry, path.join(path.resolve("C:/Grok Canvas/resources"), "app", "server.js"));
  assert.equal(launch.nodePath, path.join(launch.cwd, ".next", "node_modules"));
});

test("desktop development uses the repository standalone build", () => {
  const appPath = path.resolve("D:/projects/Grok-Canvas");
  const launch = runtime.serverLaunch({ packaged: false, resourcesPath: "", appPath });

  assert.equal(launch.cwd, appPath);
  assert.equal(launch.entry, path.join(appPath, ".next", "standalone", "server.js"));
});

test("server environment fixes the loopback port and keeps user data env", () => {
  const env = runtime.serverEnvironment({
    PATH: "test-path",
    GROK_CANVAS_DATA_DIR: "D:/canvas-data",
    ELECTRON_RUN_AS_NODE: "stale",
  }, "D:/resources/app/runtime_modules");

  assert.equal(env.PORT, "3210");
  assert.equal(env.HOSTNAME, "127.0.0.1");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.GROK_CANVAS_DATA_DIR, "D:/canvas-data");
  assert.equal(env.NEXT_TELEMETRY_DISABLED, "1");
  assert.equal(env.NODE_PATH, "D:/resources/app/runtime_modules");
});

test("external links accept only http and https", () => {
  assert.equal(runtime.externalHttpUrl("https://accounts.x.ai/oauth2/authorize"), "https://accounts.x.ai/oauth2/authorize");
  assert.equal(runtime.externalHttpUrl("http://127.0.0.1:3210/help"), "http://127.0.0.1:3210/help");
  assert.equal(runtime.externalHttpUrl("javascript:alert(1)"), null);
  assert.equal(runtime.externalHttpUrl("file:///C:/Windows/System32/calc.exe"), null);
  assert.equal(runtime.externalHttpUrl("not a url"), null);
});

test("only the local app origin is allowed to replace the main window", () => {
  assert.equal(runtime.isAppUrl("http://127.0.0.1:3210/", "http://127.0.0.1:3210"), true);
  assert.equal(runtime.isAppUrl("http://127.0.0.1:3210/canvas/1", "http://127.0.0.1:3210"), true);
  assert.equal(runtime.isAppUrl("https://accounts.x.ai/oauth2/authorize", "http://127.0.0.1:3210"), false);
  assert.equal(runtime.isAppUrl("http://127.0.0.1:3211/", "http://127.0.0.1:3210"), false);
});
