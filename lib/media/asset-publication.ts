/**
 * 媒体文件发布（P3-07）：文件系统不在 SQL 事务内，所以顺序固定为
 *   临时文件写入 → flush → 校验长度/sha256 → 无覆盖原子发布（link，目标已存在即失败）→ 删除临时文件 → 调用方登记 asset。
 * 登记失败时文件已发布，DB 回滚不会删除它：它进入 orphanReport 的可恢复清单，只标记不删除。
 * 服务端私有模块。
 */
import { createHash, randomUUID } from "node:crypto";
import { link, open, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

export type PublishedFile = { path: string; sha256: string; bytes: number };
const TEMP_PREFIX = ".publish-";

export class AssetPublicationError extends Error {
  readonly published: PublishedFile | null;
  constructor(message: string, published: PublishedFile | null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AssetPublicationError";
    this.published = published;
  }
}

/** 写入并原子发布一个新文件；目标已存在时失败且不覆盖。 */
export async function publishFile(target: string, bytes: Uint8Array): Promise<PublishedFile> {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `${TEMP_PREFIX}${randomUUID()}-${path.basename(target)}`);
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const written = await stat(temporary);
    if (written.size !== bytes.byteLength) throw new AssetPublicationError(`临时文件长度 ${written.size} 与预期 ${bytes.byteLength} 不一致`, null);
    await link(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { path: target, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

/** 发布后登记；登记失败抛出带 published 的错误，文件保留供恢复报告。 */
export async function publishAndRegister<T>(target: string, bytes: Uint8Array, register: (file: PublishedFile) => Promise<T> | T): Promise<{ file: PublishedFile; registered: T }> {
  const file = await publishFile(target, bytes);
  try {
    return { file, registered: await register(file) };
  } catch (error) {
    throw new AssetPublicationError(`文件已发布但登记失败：${path.basename(target)}`, file, { cause: error });
  }
}

export type OrphanReport = {
  /** 磁盘上有、DB 未登记、也不受保护的文件：只报告，不删除。 */
  orphans: string[];
  /** 发布中途崩溃留下的临时文件。 */
  temporary: string[];
  /** 未登记但被备份或未知/在途任务引用的文件：禁止回收。 */
  protected: string[];
};

/** 孤儿报告：只读扫描，绝不删除用户文件。 */
export async function orphanReport(assetsDir: string, registered: ReadonlySet<string>, protectedNames: ReadonlySet<string> = new Set()): Promise<OrphanReport> {
  const report: OrphanReport = { orphans: [], temporary: [], protected: [] };
  const names = await readdir(assetsDir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return [] as string[]; throw error; });
  for (const name of names.sort()) {
    if (name.startsWith(TEMP_PREFIX)) report.temporary.push(name);
    else if (registered.has(name)) continue;
    else if (protectedNames.has(name)) report.protected.push(name);
    else report.orphans.push(name);
  }
  return report;
}
