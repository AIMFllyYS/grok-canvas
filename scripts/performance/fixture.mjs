#!/usr/bin/env node
/**
 * 性能基准 fixture（P6-01）：100/1000/5000/10000 混合节点；拓扑 sparse(N 条) / 2n(2N 条) / dense(2N 条，局部密集)；
 * 可选 100KB 长文。确定性生成，不含真实账户、素材或生成请求。
 *
 * 用法：
 *   node scripts/performance/fixture.mjs --size 1000 --topology 2n [--long-text] --out <文件.json>
 *   node scripts/performance/fixture.mjs --size 1000 --import-url http://127.0.0.1:<port>   # 经公开 HTTP 接口导入（JSON 阶段）
 * 输出文件默认 wx：已存在拒绝覆盖。不会直接写活动数据目录或数据库。
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

export const SIZES = [100, 1000, 5000, 10000];
export const TOPOLOGIES = ["sparse", "2n", "dense"];
const LONG_TEXT_BYTES = 100 * 1024;

/** 比例：一半文本、5% 视频，其余图片/素材交替；文本关系不占媒体槽位。 */
export function generateFixture({ size, topology = "2n", longText = false }) {
  if (!SIZES.includes(size)) throw new Error(`size 只能是 ${SIZES.join("/")}`);
  if (!TOPOLOGIES.includes(topology)) throw new Error(`topology 只能是 ${TOPOLOGIES.join("/")}`);
  const textCount = size / 2, videoCount = size / 20;
  const normal = "## 场景 Scene\n\n人物沿着街道前行，镜头保持稳定。\n\n- Lighting: soft\n- Camera: tracking\n\n".repeat(8);
  const long = "长文压力测试，用于验证正文与几何分离。".repeat(Math.ceil(LONG_TEXT_BYTES / 57)).slice(0, Math.floor(LONG_TEXT_BYTES / 3));
  const nodes = Array.from({ length: size }, (_, index) => {
    const type = index < textCount ? "canvasText" : index >= size - videoCount ? "video" : index % 2 ? "image" : "asset";
    const data = { name: `节点 ${index}` };
    if (type === "canvasText") data.content = longText && index === 0 ? long : normal;
    else if (type === "asset") data.assetName = `fixture-${index}.png`;
    else if (type === "image") Object.assign(data, { assetName: null, prompt: "固定合成样例", aspectRatio: "auto", resolution: "1k", quality: "low", generationCount: 1, uploadAttachments: [], status: "idle", sourceNodeId: null });
    else Object.assign(data, { assetName: null, prompt: "固定合成样例", duration: 6, aspectRatio: "16:9", resolution: "720p", audio: false, uploadInputs: [], status: "idle", sourceNodeId: null });
    return { id: `node-${index}`, type, data, position: { x: (index % 100) * 320, y: Math.floor(index / 100) * 360 }, ...(type === "canvasText" ? { width: 280, height: 280 } : {}) };
  });
  const edgeCount = topology === "sparse" ? size : size * 2;
  const seen = new Set();
  const edges = [];
  const local = Math.min(textCount, 100);
  for (let index = 0; edges.length < edgeCount; index++) {
    // 文本 → 媒体（含文本）的关系：文本端不占用媒体参考槽位，可重复使用同一媒体目标。
    const source = topology === "dense" ? index % local : index % textCount;
    const target = topology === "dense" ? textCount + (Math.floor(index / local) % textCount) : textCount + ((index % textCount) + Math.floor(index / textCount)) % textCount;
    const key = `${source}->${target}`;
    if (seen.has(key)) { if (index > edgeCount * 50) throw new Error("无法生成足够的唯一边"); continue; }
    seen.add(key);
    edges.push({ id: `edge-${edges.length}`, source: `node-${source}`, target: `node-${target}`, type: "scissor", data: {} });
  }
  return { name: `性能基准 ${size} ${topology}${longText ? " 长文" : ""}`, viewport: { x: 0, y: 0, zoom: 1 }, nodes, edges };
}

function parseArgs(argv) {
  const args = { size: 1000, topology: "2n", longText: false, out: null, importUrl: null, overwrite: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--size") args.size = Number(argv[++i]);
    else if (arg === "--topology") args.topology = argv[++i];
    else if (arg === "--long-text") args.longText = true;
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--import-url") args.importUrl = argv[++i];
    else if (arg === "--overwrite") args.overwrite = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!args.out && !args.importUrl) throw new Error("必须显式指定 --out <文件> 或 --import-url <地址>");
  return args;
}

/** 经公开 HTTP 接口导入：新建画布，再以 operations 每批 1000 条写入（JSON 阶段的公开写接口）。 */
export async function importViaHttp(baseUrl, fixture, request = fetch) {
  const origin = new URL(baseUrl).origin;
  const headers = { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" };
  const created = await request(`${origin}/api/canvases`, { method: "POST", headers });
  if (!created.ok) throw new Error(`新建画布失败：${created.status}`);
  const canvas = await created.json();
  const op = (target, entity) => ({ id: randomUUID(), target, entityId: entity.id, path: [], before: { exists: false }, after: { exists: true, value: entity } });
  const operations = [...fixture.nodes.map(node => op("node", node)), ...fixture.edges.map(edge => op("edge", edge))];
  for (let i = 0; i < operations.length; i += 1000) {
    const response = await request(`${origin}/api/canvases/${canvas.id}/operations`, { method: "POST", headers, body: JSON.stringify({ operations: operations.slice(i, i + 1000) }) });
    if (!response.ok) throw new Error(`导入第 ${i / 1000 + 1} 批失败：${response.status}`);
  }
  return canvas.id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixture = generateFixture(args);
  if (args.out) {
    await mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
    await writeFile(args.out, `${JSON.stringify(fixture)}\n`, { flag: args.overwrite ? "w" : "wx" });
    console.log(`wrote ${args.out}: ${fixture.nodes.length} nodes, ${fixture.edges.length} edges`);
  }
  if (args.importUrl) console.log(`imported canvas ${await importViaHttp(args.importUrl, fixture)}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
export const __filename = fileURLToPath(import.meta.url);
