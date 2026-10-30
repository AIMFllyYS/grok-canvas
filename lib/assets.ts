import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { publishFile } from "./media/asset-publication";
import path from "node:path";
import { existsSync } from "node:fs";
import { dataDir } from "./data-dir";

/** P3-08：SQLite 权威模式下生成来源记录写入数据库（不可变，相同快照幂等）；SQL 实现按需动态加载。 */
const sqliteMode = () => existsSync(path.join(dataDir(), "storage-state.json"));

export const ASSETS_DIR = path.join(dataDir(), "assets");
export const GENERATIONS_DIR = path.join(dataDir(), "generations");

export type GenerationSnapshot = {
  originalPrompt: string;
  submittedPrompt: string;
  model: string;
  mode: "t2i" | "i2i";
  parameters: { aspectRatio: string | null; resolution: string | null; quality: string; count?: number };
  /** Actual reference order sent upstream, including images not explicitly @-mentioned. */
  referenceAssets: string[];
  startedAt: string;
};

export type VideoGenerationSnapshot = {
  originalPrompt: string;
  /** 实际发送的提示词（@ 已替换为 <IMAGE_n>）。 */
  submittedPrompt: string;
  model: string;
  mode: "t2v" | "i2v";
  /** aspectRatio 为 null 表示仅首帧模式、跟随首帧。 */
  parameters: { duration: number; aspectRatio: string | null; resolution: string | null; audio: boolean };
  /** 参考图提交顺序，<IMAGE_n> 编号由此派生。 */
  referenceAssets: string[];
  firstFrame: string | null;
  lastFrame: string | null;
  startedAt: string;
};

export type LegacyGenerationSnapshot = {
  source: "legacy";
  originalPrompt: string;
  referenceAssets: string[];
};

export type GenerationSnapshotAny = GenerationSnapshot | VideoGenerationSnapshot | LegacyGenerationSnapshot;

export type GenerationRecord = GenerationSnapshotAny & {
  schemaVersion: 1;
  assetName: string;
  savedAt: string;
};

/** Publish a complete record exclusively: subsequent writes cannot overwrite it. */
export async function saveGenerationRecord(assetName: string, snapshot: GenerationSnapshotAny): Promise<void> {
  if (!isSafeAssetName(assetName)) throw new Error("unsafe asset name");
  if (sqliteMode()) { await (await import("./db/sql-records")).saveGenerationRecordSql(assetName, snapshot, new Date().toISOString()); return; }
  await mkdir(GENERATIONS_DIR, { recursive: true });
  const destination = path.join(GENERATIONS_DIR, `${assetName}.json`);
  const temporary = path.join(GENERATIONS_DIR, `${assetName}.${crypto.randomUUID()}.tmp`);
  const record: GenerationRecord = { ...snapshot, schemaVersion: 1, assetName, savedAt: new Date().toISOString() };
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: "wx", flush: true });
    await link(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** Old/uploaded images have no record; never invent history from mutable canvas data. */
export async function readGenerationRecord(assetName: string): Promise<GenerationRecord | null> {
  if (!isSafeAssetName(assetName)) throw new Error("unsafe asset name");
  if (sqliteMode()) return (await import("./db/sql-records")).readGenerationRecordSql(assetName);
  try {
    return JSON.parse(await readFile(path.join(GENERATIONS_DIR, `${assetName}.json`), "utf8")) as GenerationRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const SAFE_NAME = /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/;

export function isSafeAssetName(name: string): boolean {
  return SAFE_NAME.test(name);
}

export function assetPath(name: string): string {
  if (!isSafeAssetName(name)) {
    throw new Error(`unsafe asset name: ${name}`);
  }
  return path.join(ASSETS_DIR, name);
}

export function mimeForAsset(name: string): string {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

function extFromMime(mime: string | null, fallback: string): string {
  const type = (mime ?? "").split(";")[0]?.trim().toLowerCase();
  switch (type) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpeg";
    case "image/webp":
      return "webp";
    case "video/mp4":
      return "mp4";
    default:
      return fallback;
  }
}

async function persist(buffer: Uint8Array, ext: string, snapshot?: GenerationSnapshotAny): Promise<{ name: string; localUrl: string; bytes: number }> {
  const name = `${crypto.randomUUID()}.${ext}`;
  await mkdir(ASSETS_DIR, { recursive: true });
  // A successful generation response must never expose an image without its record.
  // Keep the record for recovery even if writing the downloaded image later fails.
  if (snapshot) await saveGenerationRecord(name, snapshot);
  // 临时文件 → flush → 校验 → 无覆盖原子发布（P3-07）；登记在调用方，失败时文件进入孤儿报告而非被删除。
  await publishFile(assetPath(name), buffer);
  return { name, localUrl: `/api/assets/${name}`, bytes: buffer.byteLength };
}

/** Download a remote URL into data/assets (upstream image links are temporary). */
export async function saveRemoteAsset(
  url: string,
  fallbackExt: string,
  fetchImpl: typeof fetch = fetch,
  snapshot?: GenerationSnapshotAny,
): Promise<{ name: string; localUrl: string; bytes: number }> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to download asset (${response.status})`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  return persist(buffer, extFromMime(response.headers.get("content-type"), fallbackExt), snapshot);
}

export async function saveBufferAsset(
  buffer: Uint8Array,
  mime: string,
): Promise<{ name: string; localUrl: string; bytes: number }> {
  return persist(buffer, extFromMime(mime, "bin"));
}

/** Read a stored asset back as a data: URI (for edit-mode reference inputs). */
export async function assetToDataUri(name: string): Promise<string> {
  const buffer = await readFile(assetPath(name));
  return `data:${mimeForAsset(name)};base64,${buffer.toString("base64")}`;
}
