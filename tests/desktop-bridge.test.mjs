import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const { module, dispose } = await loadTypescript("lib/desktop-bridge.ts");
test.after(dispose);

test("uses the desktop bridge for an https authorization page", () => {
  const calls = [];
  globalThis.window = { grokDesktop: { openExternal: (url) => calls.push(url) } };

  assert.equal(module.hasDesktopBridge(), true);
  assert.equal(module.openExternalUrl("https://accounts.x.ai/oauth2/authorize"), true);
  assert.deepEqual(calls, ["https://accounts.x.ai/oauth2/authorize"]);

  delete globalThis.window;
});

test("does not hand unsafe or relative URLs to the desktop bridge", () => {
  const calls = [];
  globalThis.window = { grokDesktop: { openExternal: (url) => calls.push(url) } };

  assert.equal(module.openExternalUrl("javascript:alert(1)"), false);
  assert.equal(module.openExternalUrl("/auth-result"), false);
  assert.deepEqual(calls, []);

  delete globalThis.window;
});

test("reports when the page is running in a normal browser", () => {
  globalThis.window = {};

  assert.equal(module.hasDesktopBridge(), false);
  assert.equal(module.openExternalUrl("https://accounts.x.ai"), false);

  delete globalThis.window;
});
