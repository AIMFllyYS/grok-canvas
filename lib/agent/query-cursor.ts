/**
 * Agent 画布查询的分页游标（P5-03）：base64url(JSON) 编码 canvasId / queryHash / revision / 下一条位置。
 * - 解析失败、跨画布、换了查询条件 → invalid_cursor（400）；
 * - 画布修订已变化 → cursor_stale，提示从第一页重新查询，绝不默默跳页。
 */
import { createHash } from "node:crypto";

export type CursorBody = { c: string; q: string; r: number; k: number };

export class QueryError extends Error {
  constructor(readonly code: "invalid_cursor" | "cursor_stale" | "not_found" | "invalid_request", message: string, readonly status = code === "not_found" ? 404 : code === "cursor_stale" ? 409 : 400) {
    super(message);
    this.name = "QueryError";
  }
}

export const queryHash = (query: unknown) => createHash("sha256").update(JSON.stringify(query ?? null)).digest("base64url").slice(0, 16);

export function encodeCursor(body: CursorBody): string {
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined | null, expected: { canvasId: string; query: unknown; revision: number }): number {
  if (!cursor) return 0;
  let body: CursorBody;
  try {
    body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorBody;
  } catch {
    throw new QueryError("invalid_cursor", "游标无效，请不带 cursor 重新查询");
  }
  if (!body || typeof body !== "object" || typeof body.c !== "string" || typeof body.q !== "string" || !Number.isSafeInteger(body.r) || !Number.isSafeInteger(body.k) || body.k < 0) {
    throw new QueryError("invalid_cursor", "游标无效，请不带 cursor 重新查询");
  }
  if (body.c !== expected.canvasId) throw new QueryError("invalid_cursor", "游标属于其他画布");
  if (body.q !== queryHash(expected.query)) throw new QueryError("invalid_cursor", "游标与本次查询条件不一致");
  if (body.r !== expected.revision) throw new QueryError("cursor_stale", `画布已更新（修订 ${body.r} → ${expected.revision}），请从第一页重新查询`);
  return body.k;
}
