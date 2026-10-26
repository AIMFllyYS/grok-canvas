import test, { after } from "node:test";
import assert from "node:assert/strict";
import { ToolLoopAgent, tool, isStepCount } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { loadTypescript } from "./helpers/load-typescript.mjs";
const loaded = await loadTypescript("lib/agent/context.ts", { packages: true });
after(loaded.dispose);
const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const result = (content) => ({
  content,
  finishReason: { unified: "stop", raw: "stop" },
  usage,
  warnings: [],
});
test("SDK context compaction keeps full persisted UI history and the latest four user turns", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: result([
      { type: "text", text: "用户要求纸面风格；参考R1已生成，P01待制作。" },
    ]),
  });
  const messages = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `turn-${i} ${"字".repeat(1600)}`,
  }));
  const before = structuredClone(messages);
  const compacted = await loaded.module.compactContext(messages, model, 30000);
  assert.deepEqual(messages, before);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(compacted.length, 9);
  assert.ok(compacted[0].content.includes("旧对话摘要"));
  assert.deepEqual(compacted.slice(1), messages.slice(4));
});
test("single oversized turn has an explicit recoverable boundary", async () => {
  const model = new MockLanguageModelV4();
  await assert.rejects(
    loaded.module.compactContext(
      [{ role: "user", content: "字".repeat(20000) }],
      model,
      10000,
    ),
    /新建对话/,
  );
  assert.equal(model.doGenerateCalls.length, 0);
});
test("SDK tool errors carry their original execution arguments into the next model step", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        ...result([
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "reference",
            input: '{"referenceId":"MISSING"}',
          },
        ]),
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
      },
      result([{ type: "text", text: "参数MISSING无效，未生成。" }]),
    ],
  });
  const agent = new ToolLoopAgent({
    model,
    stopWhen: isStepCount(2),
    tools: {
      reference: tool({
        inputSchema: z.object({ referenceId: z.string() }),
        execute: async () => {
          throw new Error("Reference missing; no generation submitted");
        },
      }),
    },
  });
  const generated = await agent.generate({ prompt: "test failure" });
  assert.ok(generated.text.includes("未生成"));
  const next = model.doGenerateCalls[1].prompt;
  assert.ok(JSON.stringify(next).includes("MISSING"));
  assert.ok(JSON.stringify(next).includes("Reference missing"));
});
