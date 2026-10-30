/**
 * SQL 命令仓库适配（P3-05）：把 command-repository.cjs 的事务视图包装成 command-service 的 CommandStore，
 * JSON 与 SQL 两个仓库跑同一套领域命令（reducer、校验、租约、回执语义一致）。
 * 只在明确选择时使用（selectCommandStore，目前只有测试），不默认切换用户主库；正式切换与 Worker 接线在 P3-08。
 * 服务端私有模块。
 */
import type { CommandStore, ChangesPage } from "../canvas-runtime/command-service";
import type { CommandTxn } from "../canvas-runtime/json-repository";

export type SqlDatabase = { transaction<T>(fn: () => T): () => T };
export type SqlCommandModule = {
  createSqlTxn(db: SqlDatabase, canvasId: string, options?: SqlTxnOptions): CommandTxn | null;
  listChanges(db: SqlDatabase, params: { canvasId: string; afterRevision: number; limit?: number; storageEpoch?: string }): ChangesPage;
};
export type SqlTxnOptions = { trace?: (sql: string) => void; failAt?: "after_node" | "before_receipt" | "after_event" };

/** 每次 transact 是一个 SQLite 事务：edit 中任何异常（含故障注入）整体回滚，不留部分实体/回执/事件。 */
export function createSqlCommandStore(db: SqlDatabase, sql: SqlCommandModule, options: SqlTxnOptions = {}): CommandStore {
  return {
    repository: {
      async transact<T>(canvasId: string, edit: (txn: CommandTxn) => T): Promise<T | null> {
        return db.transaction(() => {
          const txn = sql.createSqlTxn(db, canvasId, options);
          return txn ? edit(txn) : null;
        })();
      },
    },
    async listChanges(params) { return sql.listChanges(db, params); },
  };
}
