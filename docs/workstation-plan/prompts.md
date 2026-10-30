# 给DeepSeek与其他Agent的交接提示词

每次只处理一个Issue；不要把所有阶段一起贴进上下文。将下面提示词中的Issue编号替换成GitHub实际编号。用户粘贴“实施任务”提示词即限定本次授权范围，不包含自动合并/收费生成/真实迁移。

## 1. 从云端基线开始（首次使用）

```text
请处理 AIMFllyYS/grok-canvas 中 Task-ID 为 G0 的 Issue。
先读取该 Issue，并从 origin/feat/workstation-performance 获取最新代码。
不要从默认 main 或 upstream 开始，也不要假设本机有前一位Agent的未提交文件。
阅读 docs/workstation-plan/README.md、protocol.md 和 bootstrap.md 的 G0。
只复现云端基线、检查CI/Issue依赖完整性、登记未测项目，按PDCA给出证据。
允许在专用分支提交脱敏证据并向本fork集成分支创建PR；不自动合并、不关闭父Issue。
未测的拖动/Electron/性能写未测，SQLite/LOD未实施写未实施。
若失败，保留首个有效错误并定位，不改业务断言制造通过。
完成后告诉我是否可以开始P2-01以及阻塞项。
```

## 2. 单Issue实施（推荐日常使用）

```text
请只实施 AIMFllyYS/grok-canvas 的 Issue #<编号>。

授权：在本fork从 origin/feat/workstation-performance 建专用 feat/ws-<Task-ID> 分支，
完成该Issue的代码、必要测试和脱敏证据，提交/推送并创建针对该集成分支的PR。
不自动合并，不向upstream提PR，不部署，不发Release，不运行真实收费生成，不迁移用户真实数据。

执行要求：
1. 先读Issue的Task-ID、docs/workstation-plan/README.md与protocol.md。
2. 读取manifest中直接依赖和它们的Act交接，确认已关闭为completed且已合入集成分支。
   任一依赖未完成/代码不存在，报告blocked并停止，不替它假写接口。
3. 只读对应阶段文档的本任务章节和指定contracts段落，再读列出的源文件。
4. Plan：列出本次文件范围、输入输出、数据不变量、失败用例、禁止事项；写入Issue评论。
5. Do：先写失败测试并真正看见红灯，再最小实现；保留上游已有保护，不跨Issue扩展。
6. Check：运行本任务专测、pnpm typecheck、pnpm test、规划校验、git diff --check，
   并按任务要求构建/native/故障/手测。每条记录退出码及实际证据，不能用“应该通过”。
7. Act：修复实际失败后重验，写 docs/workstation-plan/evidence/<Task-ID>.json，
   PR正文写单一Task-ID、Plan/Do/Check/Act四节，末尾只写Closes #本Issue编号。
8. 人工交互/实机数据缺失时明确pending，保持Issue开放，不造截图、不填0ms。
9. 同一根因三次修复仍失败，停下报告最小复现与契约冲突，不做第四次猜测。

所有接口、预算、错误语义以contracts.md为准。需要改契约时先列受影响Task-ID与证据，不能静默另造协议。
不要清空IndexedDB/数据库或降低持久化/引用校验来通过测试。
结束仅返回：本Issue实际改动、CI/测试/人工结果、PR链接、剩余风险、下一可执行任务。
不要启动别的Agent，也不要直接继续下一个Issue。
```

## 3. 多会话续接同一个Issue

```text
继续当前Issue，不开始新功能。先读Issue最近的PDCA评论、当前分支差异和证据文件。
确认实现代码SHA、最近失败命令和实际错误，再读取该任务契约与相关文件。
只处理尚未通过的Check项目；已通过且代码未变的重复研究不要再做。
如果前一会话没有保存红灯/日志，不假装有；重新做最小可重复验证。
不要重建分支覆盖现有改动，不重写已发送命令ID，不修改无关任务。
完成后更新Act和PR；未解决项如实保持blocked。
```

## 4. 只验收，不实施（最省成本）

```text
请只验收 Issue #<编号>，不修改业务代码。
阅读该任务的Check列表与protocol.md，核对PR/实现SHA和依赖。
执行尚未完成的专测/typecheck/test/build，读取CI日志；人工项目仅整理用户已提供的证据。
逐条标pass/fail/未测，附命令/退出码/日志/测试数。
第一次有效失败后保存最小错误，不反复重跑相同失败，不删断言，不升级依赖。
不得启动收费生成、迁移真实数据、清空浏览器存储或自行签收用户手测。
返回最小复现、影响Task-ID、实际与预期，以及需要实施Agent处理的项目。
```

## 5. 高风险问题升级（仅在无法收敛时使用更强模型）

```text
请分析当前Issue的一个已复现问题，不重做整个工作站设计。
我会提供：Task-ID、契约段落、失败测试/日志、实现SHA、已尝试的至多三次修复。
请先确认根因，再给最小修复范围、需同步的接口/依赖任务和回归测试。
重点核验：字段版本/undo、outbox确认边界、事务/receipt/event原子性、迁移切换、unknown收费幂等。
不要擅自改数据库选型、全局架构或删除数据。缺证据明确指出具体缺哪一项。
```

## 6. 选择下一个任务（不启动Agent）

```text
请读取 manifest.json 与总父Issue的子任务状态，按recommendedOrder找第一个尚未完成且直接依赖已完成的Task-ID。
还需核对依赖实现已合入 origin/feat/workstation-performance；closed/not_planned不算完成。
只返回下一Task-ID/Issue链接、必读契约、是否需要人工或Windows环境，以及尚未满足的依赖。
不要自动并行、不要开工实现、不要把所有剩余Issue重新分析一遍。
```

## 交接摘要应足够短

```text
Task-ID / Issue / PR：
基线SHA → 实现SHA：
Plan范围与实际差异：
红灯：命令 / 退出码 / 失败断言
绿灯：专测 / 全量 / 类型 / 构建 / 平台
人工：已确认 / pending / 不需要（附证据）
Act：修正与遗留风险
下一任务与依赖：
```

成本原则：大量上下文写在仓库中按需读取，不让普通模型记住整场对话；关键决策固定在contracts，不重复数据库选型；每Issue独立验证，失败只携带相关证据升级。
