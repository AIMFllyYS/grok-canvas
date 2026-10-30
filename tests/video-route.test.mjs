import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-video-route-"));
after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(path.join(temporary, "package.json"), '{"type":"module"}');
await mkdir(path.join(temporary, "media"), { recursive: true });
for (const name of ["data-dir", "assets", "prompt-references", "video-references", "video-request", "video-tasks", "video-generate", "media/asset-publication"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  await writeFile(path.join(temporary, `${name}.js`), output.replace(/from "(\.\/[^".]+)"/g, 'from "$1.js"'));
}

process.env.GROK_CANVAS_DATA_DIR = temporary;
const { createVideoTask, readVideoTask, updateVideoTask } = await import(
  pathToFileURL(path.join(temporary, "video-tasks.js")).href
);
const { VideoRequestError, pollVideoTask, recoverVideoTasks, submitVideoGeneration } = await import(
  pathToFileURL(path.join(temporary, "video-generate.js")).href
);

const snapshot = () => ({
  model: "grok-imagine-video-1.5",
  mode: "t2v",
  prompt: "一只纸船漂过湖面",
  compiledPrompt: "一只纸船漂过湖面",
  firstFrame: null,
  lastFrame: null,
  references: [],
  parameters: { duration: 10, aspectRatio: "16:9", resolution: "720p", audio: true },
});

const t2vBody = (overrides = {}) => ({
  prompt: "一只纸船漂过湖面",
  canvasId: "canvas-1",
  nodeId: "node-1",
  inputs: [],
  parameters: { duration: 10, aspectRatio: "16:9", resolution: "720p", audio: true },
  ...overrides,
});

function mockDeps(overrides = {}) {
  const calls = { create: [], poll: [], save: [], saveSnapshots: [], uri: [] };
  return {
    calls,
    deps: {
      createGeneration: async (body) => {
        calls.create.push(body);
        return { request_id: "req-create" };
      },
      getGeneration: async (requestId) => {
        calls.poll.push(requestId);
        return { status: "pending" };
      },
      toDataUri: async (name) => {
        calls.uri.push(name);
        return `data:image/png;base64,${name}`;
      },
      saveRemote: async (url, snapshot) => {
        calls.save.push(url);
        calls.saveSnapshots.push(snapshot);
        return { name: "saved.mp4", localUrl: "/api/assets/saved.mp4", bytes: 32 };
      },
      ...overrides,
    },
  };
}

test("带占用的视频任务完成后释放同一任务占用", async () => {
  const finished = [], verified = [];
  const { deps } = mockDeps({
    verifyClaim: async (...args) => verified.push(args),
    finishClaim: async (...args) => finished.push(args),
    getGeneration: async () => ({ status: "done", video: { url: "https://example.test/video.mp4" } }),
  });
  const claim = { nodeId: "source", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  const created = await submitVideoGeneration(t2vBody({ claim }), deps);
  const record = await readVideoTask(created.taskId);
  assert.deepEqual(record.claim, claim);
  const view = await pollVideoTask(created.taskId, deps);
  assert.equal(view.generationId, claim.id);
  assert.deepEqual(verified, [["canvas-1", "source", claim.id]]);
  assert.deepEqual(finished, [["canvas-1", "source", claim.id, "completed"]]);
});
test("视频上游提交结果不确定时保留未知占用，不自动重试", async () => {
  const finished = [];
  const { deps } = mockDeps({ verifyClaim: async () => {}, finishClaim: async (...args) => finished.push(args), createGeneration: async () => { throw new Error("断开"); } });
  const claim = { nodeId: "source", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  await assert.rejects(submitVideoGeneration(t2vBody({ claim }), deps), /断开/);
  assert.deepEqual(finished, [["canvas-1", "source", claim.id, "unknown"]]);
});
test("重启恢复时释放已终态但未清理的任务占用", async () => {
  const finished = [];
  const claim = { nodeId: "source", id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  const record = await createVideoTask("req-recovery-claim", "canvas-recovery", "output", snapshot(), claim);
  await updateVideoTask(record.taskId, { status: "failed" });
  const { deps } = mockDeps({ finishClaim: async (...args) => finished.push(args) });
  await recoverVideoTasks(deps);
  assert.deepEqual(finished, [["canvas-recovery", "source", claim.id, "completed"]]);
  assert.equal((await readVideoTask(record.taskId)).claimReleased, true);
});

test("parameter validation failures return VideoRequestError 400 with the Chinese message", async () => {
  const { deps, calls } = mockDeps();
  await assert.rejects(
    () => submitVideoGeneration(t2vBody({ prompt: "   " }), deps),
    (error) => error instanceof VideoRequestError && error.httpStatus === 400 && /提示词不能为空/.test(error.message),
  );
  await assert.rejects(
    () => submitVideoGeneration(t2vBody({ parameters: { duration: 7, aspectRatio: "16:9", resolution: "720p", audio: true } }), deps),
    /时长只支持/,
  );
  await assert.rejects(
    () =>
      submitVideoGeneration(
        t2vBody({
          inputs: [{ assetName: "city.png", role: "first" }],
          parameters: { duration: 10, aspectRatio: "16:9", resolution: "720p", audio: true },
        }),
        deps,
      ),
    /跟随首帧/,
  );
  await assert.rejects(
    () =>
      submitVideoGeneration(
        t2vBody({
          inputs: [{ assetName: "fox.png", role: "reference" }],
          parameters: { duration: 10, aspectRatio: "16:9", resolution: "1080p", audio: true },
        }),
        deps,
      ),
    /最高支持 720p/,
  );
  assert.equal(calls.create.length, 0);
});

test("creating a task submits the compiled body and persists a pending record", async () => {
  const { deps, calls } = mockDeps();
  const created = await submitVideoGeneration(t2vBody(), deps);
  assert.equal(created.requestId, "req-create");
  assert.match(created.taskId, /^[0-9a-f-]+$/);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].model, "grok-imagine-video-1.5");
  assert.equal(calls.create[0].prompt, "一只纸船漂过湖面");
  assert.equal(calls.create[0].duration, 10);
  assert.equal(calls.create[0].resolution, "720p");
  assert.equal(calls.create[0].aspect_ratio, "16:9");
  assert.equal(calls.create[0].generate_audio, true);
  assert.equal(calls.create[0].image, undefined);

  const record = await readVideoTask(created.taskId);
  assert.equal(record.status, "pending");
  assert.equal(record.canvasId, "canvas-1");
  assert.equal(record.nodeId, "node-1");
  assert.equal(record.snapshot.compiledPrompt, "一只纸船漂过湖面");
});

test("a first-frame request omits aspect_ratio and sends image as a data URI object", async () => {
  const { deps, calls } = mockDeps();
  await submitVideoGeneration(
    t2vBody({
      inputs: [{ assetName: "city.png", role: "first" }],
      parameters: { duration: 10, aspectRatio: null, resolution: "720p", audio: true },
    }),
    deps,
  );
  assert.deepEqual(calls.uri, ["city.png"]);
  assert.equal("aspect_ratio" in calls.create[0], false);
  assert.deepEqual(calls.create[0].image, { url: "data:image/png;base64,city.png" });
});

test("done downloads immediately and becomes completed", async () => {
  const record = await createVideoTask("req-done", "canvas-1", "node-done", snapshot());
  const { deps, calls } = mockDeps({
    getGeneration: async (requestId) => {
      calls.poll.push(requestId);
      return { status: "done", video: { url: "https://vidgen.example/clip.mp4" } };
    },
  });
  const view = await pollVideoTask(record.taskId, deps);
  assert.equal(view.status, "completed");
  assert.equal(view.result.assetName, "saved.mp4");
  assert.equal(view.result.localUrl, "/api/assets/saved.mp4");
  assert.equal(typeof view.waitedSeconds, "number");
  assert.deepEqual(calls.save, ["https://vidgen.example/clip.mp4"]);
  const saved = calls.saveSnapshots[0];
  assert.equal(saved.originalPrompt, "一只纸船漂过湖面");
  assert.equal(saved.submittedPrompt, "一只纸船漂过湖面");
  assert.equal(saved.model, "grok-imagine-video-1.5");
  assert.equal(saved.mode, "t2v");
  assert.deepEqual(saved.parameters, { duration: 10, aspectRatio: "16:9", resolution: "720p", audio: true });
  assert.deepEqual(saved.referenceAssets, []);
  assert.equal(saved.firstFrame, null);
  assert.equal(saved.startedAt, record.createdAt);
  const loaded = await readVideoTask(record.taskId);
  assert.equal(loaded.status, "completed");
  assert.equal(loaded.remoteUrl, "https://vidgen.example/clip.mp4");
});

test("a failed download becomes save_failed and a later poll retries without resubmitting", async () => {
  const record = await createVideoTask("req-save", "canvas-1", "node-save", snapshot());
  let downloads = 0;
  const { deps, calls } = mockDeps({
    getGeneration: async (requestId) => {
      calls.poll.push(requestId);
      return { status: "done", video: { url: "https://vidgen.example/retry.mp4" } };
    },
    saveRemote: async (url) => {
      calls.save.push(url);
      downloads += 1;
      if (downloads === 1) throw new Error("failed to download asset (502)");
      return { name: "retried.mp4", localUrl: "/api/assets/retried.mp4", bytes: 64 };
    },
  });

  const failed = await pollVideoTask(record.taskId, deps);
  assert.equal(failed.status, "save_failed");
  assert.match(failed.error, /视频保存失败/);
  assert.equal((await readVideoTask(record.taskId)).remoteUrl, "https://vidgen.example/retry.mp4");

  const completed = await pollVideoTask(record.taskId, deps);
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.assetName, "retried.mp4");
  assert.deepEqual(calls.poll, ["req-save"]);
  assert.deepEqual(calls.save, ["https://vidgen.example/retry.mp4", "https://vidgen.example/retry.mp4"]);
  assert.equal(calls.create.length, 0);
});

test("a gone remote URL on save retry is marked expired", async () => {
  const record = await createVideoTask("req-gone", "canvas-1", "node-gone", snapshot());
  await updateVideoTask(record.taskId, {
    status: "save_failed",
    remoteUrl: "https://vidgen.example/gone.mp4",
    error: "视频保存失败：failed to download asset (502)",
  });
  const { deps, calls } = mockDeps({
    saveRemote: async (url) => {
      calls.save.push(url);
      throw new Error("failed to download asset (410)");
    },
  });
  const view = await pollVideoTask(record.taskId, deps);
  assert.equal(view.status, "expired");
  assert.match(view.error, /临时链接已过期/);
  assert.equal(calls.poll.length, 0);
  assert.equal((await readVideoTask(record.taskId)).status, "expired");
});

test("upstream failed or expired marks the task failed", async () => {
  const failed = await createVideoTask("req-fail", "canvas-1", "node-fail", snapshot());
  const expired = await createVideoTask("req-up-expired", "canvas-1", "node-up-expired", snapshot());
  const { deps } = mockDeps({
    getGeneration: async (requestId) => ({ status: requestId === "req-fail" ? "failed" : "expired" }),
  });
  assert.equal((await pollVideoTask(failed.taskId, deps)).status, "failed");
  assert.match((await pollVideoTask(expired.taskId, deps)).error, /上游生成失败（expired）/);
  assert.equal((await readVideoTask(failed.taskId)).status, "failed");
  assert.equal((await readVideoTask(expired.taskId)).status, "failed");
});

test("terminal tasks are returned as-is without calling upstream", async () => {
  const record = await createVideoTask("req-terminal", "canvas-1", "node-terminal", snapshot());
  await updateVideoTask(record.taskId, {
    status: "completed",
    result: { assetName: "done.mp4", localUrl: "/api/assets/done.mp4", bytes: 8 },
  });
  const { deps, calls } = mockDeps();
  const view = await pollVideoTask(record.taskId, deps);
  assert.equal(view.status, "completed");
  assert.equal(view.result.assetName, "done.mp4");
  assert.equal(calls.poll.length, 0);
  assert.equal(calls.save.length, 0);
});

test("recover only advances pending and save_failed tasks", async () => {
  const pending = await createVideoTask("req-rec-pending", "canvas-1", "node-rec-pending", snapshot());
  const saveFailed = await createVideoTask("req-rec-save", "canvas-1", "node-rec-save", snapshot());
  await updateVideoTask(saveFailed.taskId, {
    status: "save_failed",
    remoteUrl: "https://vidgen.example/recover.mp4",
    error: "视频保存失败：failed to download asset (502)",
  });
  const completed = await createVideoTask("req-rec-done", "canvas-1", "node-rec-done", snapshot());
  await updateVideoTask(completed.taskId, { status: "completed" });
  const failed = await createVideoTask("req-rec-fail", "canvas-1", "node-rec-fail", snapshot());
  await updateVideoTask(failed.taskId, { status: "failed", error: "上游生成失败（failed）" });
  const expired = await createVideoTask("req-rec-expired", "canvas-1", "node-rec-expired", snapshot());
  await updateVideoTask(expired.taskId, { status: "expired", error: "临时链接已过期，无法恢复" });

  const { deps, calls } = mockDeps({
    getGeneration: async (requestId) => {
      calls.poll.push(requestId);
      return { status: "done", video: { url: "https://vidgen.example/pending.mp4" } };
    },
  });
  const views = await recoverVideoTasks(deps);
  const byId = new Map(views.map((view) => [view.taskId, view]));
  assert.equal(byId.get(pending.taskId).status, "completed");
  assert.equal(byId.get(saveFailed.taskId).status, "completed");
  assert.equal(byId.has(completed.taskId), false);
  assert.equal(byId.has(failed.taskId), false);
  assert.equal(byId.has(expired.taskId), false);
  assert.ok(calls.poll.includes("req-rec-pending"));
  assert.ok(!calls.poll.includes("req-rec-save"));
  assert.ok(!calls.poll.includes("req-rec-done"));
  assert.ok(!calls.poll.includes("req-rec-fail"));
  assert.ok(!calls.poll.includes("req-rec-expired"));
  assert.ok(calls.save.includes("https://vidgen.example/pending.mp4"));
  assert.ok(calls.save.includes("https://vidgen.example/recover.mp4"));
  assert.equal((await readVideoTask(completed.taskId)).status, "completed");
  assert.equal((await readVideoTask(failed.taskId)).status, "failed");
  assert.equal((await readVideoTask(expired.taskId)).status, "expired");
});
