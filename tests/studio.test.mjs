import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const schema = await loadTypescript("lib/studio/schema.ts", { packages: true });
const messageHelpers = await loadTypescript("lib/studio/messages.ts");
test("assistant message IDs stay unique and stable across reloads", () => {
  const input = [
    { id: "u1", role: "user", parts: [] },
    { id: "", role: "assistant", parts: [] },
    { id: "u1", role: "assistant", parts: [] },
  ];
  const repaired = messageHelpers.module.normalizeMessages(input, "project");
  assert.equal(new Set(repaired.map((m) => m.id)).size, 3);
  assert.deepEqual(
    messageHelpers.module.normalizeMessages(input, "project"),
    repaired,
  );
  assert.deepEqual(
    messageHelpers.module.normalizeMessages(repaired, "project"),
    repaired,
  );
});
test("interrupted tools become explicit errors and incomplete arguments cannot poison the next SDK turn",async()=>{
  const pending=[{id:"a",role:"assistant",parts:[{type:"tool-example",toolCallId:"partial",state:"input-streaming",input:{query:3}},{type:"tool-example",toolCallId:"running",state:"input-available",input:{query:"boat"}}]}];
  const finalized=messageHelpers.module.finalizeInterruptedMessages(pending,"p");assert.equal(finalized[0].parts[0].type,"text");assert.equal(finalized[0].parts[1].state,"output-error");
  const {validateUIMessages,convertToModelMessages,tool}=await import("ai");const {z}=await import("zod");
  const messages=await validateUIMessages({messages:finalized,tools:{example:tool({inputSchema:z.object({query:z.string()})})}});const model=await convertToModelMessages(messages);assert.equal(model.at(-1).role,"tool");
});
const { validatePlan, shotPrompt, timeline, exportSignature } = schema.module;
const bi = (text) => ({ zh: `中文 ${text}`, en: text });
const shot = {
  id: "P01",
  title: "纸船",
  scene: "小溪",
  duration: 6,
  description: bi("A paper boat (@BOAT) in a stream"),
  camera: bi("Locked top-down camera"),
  refs: ["BOAT"],
  beats: [
    { start: 0, end: 3, action: bi("Boat drifts right") },
    { start: 3, end: 6, action: bi("Ripples settle") },
  ],
  narration: "",
  notes: "",
};
const plan = {
  title: "纸船",
  logline: "",
  script: "Complete director script for paper boat.",
  style: bi("Watercolor"),
  negative: bi("flicker, watermark"),
  aspect: "16:9",
  references: [
    {
      id: "BOAT",
      name: "纸船",
      group: "道具",
      description: "",
      prompt: bi("Cream paper boat"),
    },
  ],
  shots: [shot],
};

test("production plan rejects gaps, overlapping beats, unsupported references and speech instructions", () => {
  assert.deepEqual(validatePlan(plan), []);
  for (const mutate of [
    (p) => (p.shots[0].beats[1].start = 4),
    (p) => (p.shots[0].beats[1].end = 7),
    (p) => (p.shots[0].beats[0].end = 0.5),
    (p) => (p.shots[0].refs = ["MISSING"]),
    (p) => (p.shots[0].description.en = "A boat says hello"),
    (p) => (p.shots[0].description.en = "A 船 floats"),
    (p) => p.shots.push(structuredClone(shot)),
  ]) {
    const invalid = structuredClone(plan);
    mutate(invalid);
    assert.ok(validatePlan(invalid).length);
  }
  const single = structuredClone(plan);
  single.shots[0].description.en = "A single boat";
  assert.deepEqual(validatePlan(single), [], "sing must not match single");
});
test("every prompt inherits style and final negative constraints; global timeline stays consecutive", () => {
  const prompt = shotPrompt(plan, shot);
  assert.ok(prompt.startsWith("Watercolor 16:9"));
  assert.ok(prompt.includes("(@BOAT)"));
  assert.ok(prompt.includes("0-3s:"));
  assert.ok(prompt.endsWith("Avoid: flicker, watermark"));
  assert.doesNotMatch(prompt, /[\u3400-\u9fff]/);
  const times = timeline([shot, { ...shot, id: "P02", duration: 10 }]);
  assert.deepEqual(
    times.map((s) => [s.timelineStart, s.timelineEnd]),
    [
      [0, 6],
      [6, 16],
    ],
  );
});
test("export signature changes when a video, order, duration or approval changes", () => {
  const p = { shots: [{ ...shot, videoAsset: "a.mp4", videoApproved: true }] };
  for (const change of [
    { videoAsset: "b.mp4" },
    { duration: 10 },
    { videoApproved: false },
  ])
    assert.notEqual(
      exportSignature(p),
      exportSignature({ shots: [{ ...p.shots[0], ...change }] }),
    );
});
test("project persistence serializes writes, rejects stale revisions and isolates paid operation locks", async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), "grok-studio-data-"));
  process.env.GROK_CANVAS_DATA_DIR = data;
  const store = await loadTypescript("lib/studio/store.ts", { packages: true });
  try {
    const s = store.module,
      p = await s.createProject("test"),
      other = await s.createProject("other");
    const results = await Promise.allSettled([
      s.updateProject(
        p.id,
        (p) => {
          p.brief = "A";
        },
        0,
      ),
      s.updateProject(
        p.id,
        (p) => {
          p.brief = "B";
        },
        0,
      ),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      results.filter((r) => r.status === "rejected")[0].reason.status,
      409,
    );
    const unlock = s.acquireProduction(p.id);
    assert.throws(() => s.acquireProduction(p.id), /制作中/);
    assert.equal(s.isProducing(p.id), true);
    const unlockOther = s.acquireProduction(other.id);
    unlockOther();
    unlock();
    assert.equal(s.isProducing(p.id), false);
    await s.updateProject(p.id, (p) => {
      p.sources.push({
        id: "source",
        name: "source.md",
        kind: "text",
        text: "Original material",
      });
    });
    assert.equal(
      (await s.loadProject(p.id)).sources[0].text,
      "Original material",
    );
    assert.equal((await s.listProjects()).length, 2);
    await assert.rejects(() => s.loadProject("../auth"), /无效项目/);
    await assert.rejects(
      () =>
        s.updateProject(p.id, () => {
          throw new Error("mutation failed");
        }),
      /mutation failed/,
    );
    await s.updateProject(p.id, (p) => {
      p.title = "Still writable";
    });
    assert.equal((await s.loadProject(p.id)).title, "Still writable");
  } finally {
    await store.dispose();
    await rm(data, { recursive: true, force: true });
    delete process.env.GROK_CANVAS_DATA_DIR;
  }
});

test("canvas synchronization preserves unrelated user nodes and managed positions", async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), "grok-studio-canvas-"));
  process.env.GROK_CANVAS_DATA_DIR = data;
  const canvasModule = await loadTypescript("lib/studio/canvas.ts", {
    packages: true,
  });
  try {
    // Load the store from the SAME compiled graph to share its optimistic-lock state.
    const { pathToFileURL } = await import("node:url");
    const cs = await import(
      pathToFileURL(path.join(canvasModule.directory, "lib/canvas-store.js"))
        .href
    );
    const canvas = await cs.createCanvas();
    const p = {
      ...plan,
      id: "test-project",
      canvasId: canvas.id,
      brief: "Brief",
      sources: [],
      createdAt: new Date().toISOString(),
    };
    await cs.saveCanvas(
      {
        ...canvas,
        nodes: [
          {
            id: "user-node",
            type: "image",
            position: { x: 99, y: 123 },
            data: { name: "Keep me" },
          },
        ],
      },
      canvas.revision,
    );
    const first = await canvasModule.module.syncProjectCanvas(p);
    const managed = first.nodes.find((n) => n.id.endsWith("shot-P01"));
    managed.position = { x: 321, y: 456 };
    await cs.saveCanvas(first, first.revision);
    const second = await canvasModule.module.syncProjectCanvas({
      ...p,
      title: "Updated",
    });
    assert.equal(
      second.nodes.find((n) => n.id === "user-node").data.name,
      "Keep me",
    );
    assert.deepEqual(
      second.nodes.find((n) => n.id.endsWith("shot-P01")).position,
      { x: 321, y: 456 },
    );
    assert.equal(second.nodes.length, 7);
    assert.ok(second.edges.some((e) => e.target.endsWith("assembly")));
  } finally {
    await canvasModule.dispose();
    await rm(data, { recursive: true, force: true });
    delete process.env.GROK_CANVAS_DATA_DIR;
  }
});
test.after(async () => {
  await schema.dispose();
  await messageHelpers.dispose();
});

test("failed image downloads resume the same result without calling image generation", async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), "grok-studio-image-"));
  process.env.GROK_CANVAS_DATA_DIR = data;
  const originalFetch = globalThis.fetch;
  const media = await loadTypescript("lib/studio/media.ts", { packages: true });
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) throw new Error("temporary disconnect");
      return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
        headers: { "content-type": "image/png" },
      });
    };
    const file = path.join(data, "job.json");
    const job = {
      status: "download",
      prompt: "same prompt",
      url: "https://example.test/result",
      snapshot: {
        originalPrompt: "same prompt",
        submittedPrompt: "same prompt",
        model: "test",
        mode: "t2i",
        parameters: { aspectRatio: "16:9", resolution: "1k", quality: "low" },
        referenceAssets: [],
        startedAt: new Date().toISOString(),
      },
    };
    const result = await media.module.recoverImageJob(file, job);
    assert.equal(calls, 2);
    assert.ok(result.assetName.endsWith(".png"));
    assert.equal(JSON.parse(await readFile(file, "utf8")).status, "completed");
    assert.ok(
      (await readFile(path.join(data, "assets", result.assetName))).length,
    );
    globalThis.fetch = async () => new Response(null, { status: 410 });
    await assert.rejects(
      () => media.module.recoverImageJob(file, job),
      /确认重新生成/,
    );
    const expired = JSON.parse(await readFile(file, "utf8"));
    assert.equal(expired.status, "expired");
    await mkdir(path.join(data, "studio-image-jobs"), { recursive: true });
    await writeFile(
      path.join(data, "studio-image-jobs", "expired.json"),
      JSON.stringify(expired),
    );
    await assert.rejects(
      () =>
        media.module.generateStudioImage("same prompt", "16:9", [], "expired"),
      /确认重新生成/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await media.dispose();
    await rm(data, { recursive: true, force: true });
    delete process.env.GROK_CANVAS_DATA_DIR;
  }
});

test("video submission journal repairs lost task linkage and refuses uncertain automatic resubmission", async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), "grok-studio-submit-"));
  process.env.GROK_CANVAS_DATA_DIR = data;
  const loaded = await loadTypescript("lib/studio/video-submit.ts", {
    packages: true,
  });
  try {
    let submissions = 0;
    const deps = {
      createGeneration: async () => ({
        request_id: `request-${++submissions}`,
      }),
      getGeneration: async () => ({ status: "pending" }),
      toDataUri: async () => "data:image/png;base64,AA==",
      saveRemote: async () => {
        throw new Error("not used");
      },
    };
    const p = { ...plan, id: "journal-project", canvasId: "journal-canvas" },
      s = { ...shot, imageAsset: "first.png" };
    const first = await loaded.module.submitStudioVideo(p, s, false, deps);
    assert.equal(submissions, 1);
    const recovered = await loaded.module.submitStudioVideo(p, s, false, deps);
    assert.equal(recovered.taskId, first.taskId);
    assert.equal(recovered.recovered, true);
    assert.equal(submissions, 1);
    const forcedPending = await loaded.module.submitStudioVideo(
      p,
      s,
      true,
      deps,
    );
    assert.equal(forcedPending.taskId, first.taskId);
    assert.equal(
      submissions,
      1,
      "even explicit force cannot duplicate a known pending task",
    );
    await writeFile(
      path.join(data, "studio-video-submissions", "uncertain-P01.json"),
      JSON.stringify({ status: "submitting", signature: "unknown" }),
    );
    await assert.rejects(
      () =>
        loaded.module.submitStudioVideo(
          { ...p, id: "uncertain" },
          s,
          false,
          deps,
        ),
      /禁止自动重发/,
    );
    assert.equal(submissions, 1);
    const acceptedFile = path.join(
        data,
        "studio-video-submissions",
        "journal-project-P01.json",
      ),
      accepted = JSON.parse(await readFile(acceptedFile, "utf8"));
    delete accepted.taskId;
    await writeFile(acceptedFile, JSON.stringify(accepted));
    const recoveredRequest = await loaded.module.submitStudioVideo(
      p,
      s,
      false,
      deps,
    );
    assert.equal(recoveredRequest.requestId, first.requestId);
    assert.equal(submissions, 1);
    await assert.rejects(
      () =>
        loaded.module.submitStudioVideo(
          { ...p, id: "../auth" },
          s,
          false,
          deps,
        ),
      /无效视频任务/,
    );
  } finally {
    await loaded.dispose();
    await rm(data, { recursive: true, force: true });
    delete process.env.GROK_CANVAS_DATA_DIR;
  }
});

test("autonomous batch reports each stage, preserves existing work and continues independent references", async () => {
  const loaded = await loadTypescript("lib/studio/batch.ts", {
    packages: true,
  });
  try {
    const p = {
      script: "existing script",
      references: Array.from({ length: 20 }, (_, i) => ({ id: `R${i}` })),
      shots: [
        { id: "P01", refs: ["R0"] },
        { id: "P02", refs: ["R3"] },
      ],
    };
    const calls = [];
    const deps = {
      load: async () => p,
      produce: async (_id, stage, { targetId }) => {
        calls.push(`${stage}:${targetId}`);
        if (stage === "reference") {
          if (targetId === "R3") throw new Error("one blocked reference");
          p.references.find((r) => r.id === targetId).assetName =
            `${targetId}.png`;
        } else {
          const s = p.shots.find((s) => s.id === targetId);
          if (stage === "storyboard") {
            if (
              s.refs.some(
                (id) => !p.references.find((r) => r.id === id).assetName,
              )
            )
              throw new Error("missing reference");
            s.imageAsset = `${targetId}.png`;
          } else {
            if (!s.imageAsset) throw new Error("missing storyboard");
            s.taskId = `task-${targetId}`;
          }
        }
      },
    };
    const progress = [];
    for await (const value of loaded.module.runProductionBatch(
      "project",
      "all",
      undefined,
      deps,
    ))
      progress.push(value);
    assert.ok(progress.length > 30);
    assert.equal(progress.at(-1).finished, true);
    assert.ok(progress.at(-1).failed.some((f) => f.id === "reference:R3"));
    assert.equal(p.shots[0].taskId, "task-P01");
    assert.equal(p.shots[1].taskId, undefined);
    assert.ok(calls.indexOf("reference:R19") < calls.indexOf("storyboard:P01"));
    const before = calls.length;
    for await (const _ of loaded.module.runProductionBatch(
      "project",
      "video",
      undefined,
      deps,
    )) {
    }
    assert.equal(
      calls.slice(before).includes("video:P01"),
      false,
      "known pending videos must be preserved",
    );
  } finally {
    await loaded.dispose();
  }
});

const hasFfmpeg =
  spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], {
    windowsHide: true,
  }).status === 0 &&
  spawnSync("ffprobe", ["-version"], { windowsHide: true }).status === 0;
test(
  "real FFmpeg export requires review, normalizes two clips, concatenates in order and caches",
  { skip: !hasFfmpeg },
  async () => {
    const data = await mkdtemp(path.join(os.tmpdir(), "grok-studio-export-"));
    process.env.GROK_CANVAS_DATA_DIR = data;
    const exporter = await loadTypescript("lib/studio/export.ts", {
      packages: true,
    });
    try {
      const { pathToFileURL } = await import("node:url");
      const store = await import(
        pathToFileURL(path.join(exporter.directory, "lib/studio/store.js")).href
      );
      const p = await store.createProject("Two colors");
      await mkdir(path.join(data, "assets"), { recursive: true });
      for (const color of ["red", "blue"])
        execFileSync(
          process.env.FFMPEG_PATH || "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            `color=c=${color}:s=64x64:r=4:d=6`,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            path.join(data, "assets", `${color}.mp4`),
          ],
          { windowsHide: true },
        );
      await store.updateProject(p.id, (p) => {
        p.shots = [
          { ...shot, videoAsset: "red.mp4", videoApproved: true },
          { ...shot, id: "P02", videoAsset: "blue.mp4", videoApproved: false },
        ];
      });
      await assert.rejects(() => exporter.module.exportProject(p.id), /验收/);
      await store.updateProject(p.id, (p) => {
        p.shots[1].videoApproved = true;
      });
      const result = await exporter.module.exportProject(p.id);
      assert.equal(result.cached, false);
      const output = path.join(data, "assets", result.assetName);
      const metadata = JSON.parse(
        execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_name,width,height",
            "-of",
            "json",
            output,
          ],
          { encoding: "utf8", windowsHide: true },
        ),
      );
      assert.equal(Number(metadata.format.duration), 12);
      assert.equal(metadata.streams[0].width, 1280);
      assert.equal(metadata.streams[0].height, 720);
      const pixel = (time) =>
        execFileSync(
          process.env.FFMPEG_PATH || "ffmpeg",
          [
            "-v",
            "error",
            "-ss",
            String(time),
            "-i",
            output,
            "-frames:v",
            "1",
            "-vf",
            "scale=1:1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ],
          { windowsHide: true },
        );
      const first = pixel(1),
        second = pixel(7);
      assert.ok(first[0] > first[2], "first clip must be red");
      assert.ok(second[2] > second[0], "second clip must be blue");
      const cached = await exporter.module.exportProject(p.id);
      assert.equal(cached.cached, true);
      assert.equal(cached.assetName, result.assetName);
    } finally {
      await exporter.dispose();
      await rm(data, { recursive: true, force: true });
      delete process.env.GROK_CANVAS_DATA_DIR;
    }
  },
);
