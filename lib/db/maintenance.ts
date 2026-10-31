/**
 * 维护模式（P3-08）：<dataDir>/maintenance.json 存在时，新命令、新生成与 claim 一律以 maintenance 拒绝（可重试，outbox 保留）。
 * 由切换工具（lib/db/cutover.cjs）在准备阶段写入、提交后删除；服务端只读。服务端私有模块。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../data-dir";

export const MAINTENANCE_FILE = "maintenance.json";
export type MaintenanceState = { active: false } | { active: true; reason: string; since: string };

export function maintenanceState(dir: string = dataDir()): MaintenanceState {
  const file = path.join(dir, MAINTENANCE_FILE);
  if (!existsSync(file)) return { active: false };
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { reason?: unknown; since?: unknown };
    return { active: true, reason: typeof value.reason === "string" ? value.reason : "maintenance", since: typeof value.since === "string" ? value.since : "" };
  } catch {
    return { active: true, reason: "maintenance", since: "" };
  }
}

export class MaintenanceError extends Error {
  readonly code = "maintenance";
  readonly status = 423;
  constructor(reason: string) { super(`系统正在维护（${reason}），请稍候再试；未保存的修改会保留并自动重试`); this.name = "MaintenanceError"; }
}

export function assertNoMaintenance(): void {
  const state = maintenanceState();
  if (state.active) throw new MaintenanceError(state.reason);
}
