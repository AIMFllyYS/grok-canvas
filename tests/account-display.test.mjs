import test from "node:test";
import assert from "node:assert/strict";
import { accountDisplay, safeProfilePicture } from "../lib/account-display.ts";

test("账户显示邮箱前缀和首字", () => {
  assert.deepEqual(accountDisplay("alice@example.com"), { name: "alice", initial: "A" });
  assert.deepEqual(accountDisplay("小王@example.com"), { name: "小王", initial: "小" });
  assert.deepEqual(accountDisplay(null), { name: "用户", initial: "用" });
  assert.equal(accountDisplay("@example.com").name, "用户");
});
test("头像只能是无嵌入凭据的HTTPS地址", () => {
  assert.equal(safeProfilePicture("https://example.com/avatar.png"), "https://example.com/avatar.png");
  for (const url of [null, "http://example.com", "javascript:alert(1)", "https://user:pass@example.com"]) assert.equal(safeProfilePicture(url), null);
});
