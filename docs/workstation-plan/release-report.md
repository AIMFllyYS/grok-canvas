# 工作站性能改造：故障矩阵与发布报告（P6-02 / P6-04）

本文件汇总批次 A–D 的可靠性证据、已知限制与回滚方式。合成数据测试；没有在真实数据目录做故障注入。

## 故障矩阵（P6-02）

| 故障 | 期望 | 结果 | 证据 |
|---|---|---|---|
| 命令已提交但回执丢失，客户端重试 | 只执行一次：修订、事件、回执各 +1，同步通知不重复 | 通过 | `tests/workstation-faults.test.mjs` |
| SQLITE_BUSY | 返回可重试的 storage_unavailable，无部分写入；重试执行一次 | 通过 | `tests/workstation-faults.test.mjs` |
| 回执已压缩后重放旧命令 | 不重新执行，修订不变，integrity_check ok | 通过 | `tests/workstation-faults.test.mjs`、`tests/db-retention.test.mjs` |
| 用户编辑正文时 Agent 改同字段 | 工具 blocked，正文不变；租约释放后成功 | 通过 | `tests/workstation-faults.test.mjs` |
| 删节点后迟到的 Agent 修改 | 拒绝，不复活 | 通过 | `tests/workstation-faults.test.mjs` |
| 视频提交后断网，反复重试 | 工具 unknown；收费 POST 恰好 1 次 | 通过 | `tests/agent-run-recovery.test.mjs` |
| 删除画布后迟到的工具写入 | 不重建画布 | 通过 | `tests/agent-run-recovery.test.mjs` |
| 进程中断后停在中间态的工具调用 | executing → unknown，执行前 → failed，幂等 | 通过 | `tests/agent-run-recovery.test.mjs` |
| SSE 断线 / 后台页 / 乱序与重复事件 | 重连补拉，乱序丢弃，后台断开回前台补齐 | 通过 | `tests/canvas-sync.test.mjs`、`scripts/e2e/canvas-sync.e2e.mjs` |
| 压缩到一半崩溃 | 事件、回执、水位都不变 | 通过 | `tests/db-retention.test.mjs` |
| DB Worker 退出 / 队列满 / 超时 | 明确错误，可恢复 | 通过 | `tests/db-worker.test.mjs` |
| 迁移中断、源文件变化 | 续跑一致，变化拒绝 | 通过 | `tests/db-import.test.mjs` |
| 备份时并发写、媒体缺失、篡改 | 备份一致，校验失败可见 | 通过 | `tests/db-backup.test.mjs` |
| outbox 达到本地容量上限（条数/字节） | 拒绝新命令（queue_full）并保留已有；浏览器真实 IndexedDB 配额错误未单独注入 | 通过 | `tests/canvas-outbox.test.mjs` |
| 磁盘满 / 无写权限 | storage_unavailable | 只有错误映射单测，未做真实磁盘注入 | `lib/canvas-runtime/command-service.ts` toCommandError |

## 性能（P6-03）

详见 `docs/workstation-plan/evidence/P6-03.json`。拖动帧间隔 p95：1000 节点 16.7ms（基线 33ms），5000 节点 100ms（基线 300ms），10000 节点 66.7ms。4 分钟 soak 期间无错误，结束后堆与监听器回到起始水平。5000 节点以上的拖动与 10000 节点首次加载未达到 C9 目标。

## 发布检查（P6-04）

- `tests/workstation-release.test.mjs`：所有测试文件都在 `pnpm test` 链里；原生依赖精确锁定；DB 运行时打包列表覆盖 Worker 的全部本地依赖；证据文件不含本机用户目录或疑似密钥。
- 干净安装、Node 22/24、standalone 与 Windows Electron 三端启动与备份/恢复：由 CI（`.github/workflows/workstation-ci.yml`）每个 PR 执行。
- 未做：Windows 安装包在隔离用户目录的手动首次启动；真实触控板、高 DPI 与 Electron 窗口内的人工交互矩阵。

## 回滚

- 代码：集成分支 `feat/workstation-performance` 未合并到 main；回到任意批次的合并提交即可。
- 数据：切换到 SQLite 前会完整备份数据目录。切换是单向的（不会自动切回 JSON），回滚方式是停止应用后用备份目录替换数据目录。
