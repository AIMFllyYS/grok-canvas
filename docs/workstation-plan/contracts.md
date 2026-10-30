# 工作站跨 Issue 契约

本文定义待实现接口，不声称这些接口已在基线存在。P2-01 将类型固化到代码；后续任务只消费它，不另建同义类型。修改契约必须列出受影响 Task-ID、兼容策略和测试，不能由单个 Agent 静默决定。

## C1 状态和实体

四个所有者：DocumentStore 持有正式实体与确认版本；GestureState 持有正在拖动/resize 的小型几何覆盖；ViewState 持有选择、相机、面板草稿/光标/滚动；TaskState/PreviewState 持有执行和临时呈现。

```ts
type FieldVersion = number;
type Geometry = { x: number; y: number; width: number; height: number };
type NodeSummary = {
  id: string; canvasId: string; type: string; schemaVersion: number;
  geometry: Geometry; entityVersion: number; geometryVersion: FieldVersion;
  documentId: string | null; data: Readonly<Record<string, unknown>>;
};
type DocumentRecord = { id: string; nodeId: string; content: string; version: FieldVersion };
type EdgeRecord = { id: string; canvasId: string; source: string; target: string;
  role: "first" | "last" | "reference" | null; version: number };
type FieldRef = { target: "node" | "document" | "edge" | "canvas";
  id: string; field: string };
type Subscription = () => void;
```

- NodeSummary.data 不包含 content；content 单独订阅 DocumentRecord。prompt 保留在节点 data 中，具有独立字段版本。
- `geometry` 是一个原子字段组（x/y/width/height），移动和 resize 互斥；不同内容字段可并行。
- `entityVersion` 在任一字段变动时递增，删除以它做前置条件；普通 patch 不按 entityVersion 拒绝无关字段变化。
- 外部暴露 Readonly 对象，不暴露可修改 Map；无变化 getSnapshot 必须返回相同引用。
- 初始化一次构建 node/edge/incoming/outgoing/assetReverse/spatial 索引；位置修改只碰几何和空间索引。
- `createCanvasStore(seed)` 暴露 `getNode(id) / getDocument(id) / getEdge(id) / getNodeIds() / subscribeNode(id, fn) / subscribeDocument(id, fn) / subscribeStructure(fn) / applyDelta(delta) / dispose()`。
- `useSyncExternalStore` 的订阅建立/清理可验证；单节点内容更新不通知无关节点或结构订阅。
- 新节点注册表固定支持 image/video/asset/canvasText，记录 `type/schemaVersion/validate/migrate`；未知类型在导入时明确阻断/报告，不静默抹除。
- 字段归属（P2-01 固化于 `lib/canvas-runtime/node-registry.ts`）：`user` 可由 patch_nodes 写；`service` 只由服务端命令写；`legacy` 仅新增/导入接受、不可 patch。旧 React Flow 顶层 `draggable:false`（固定节点）映射为公共用户字段 `data.pinned=true`；Agent addNodes 写入的跨类型默认值（image 的 duration/audio/uploadInputs，video 的 quality/generationCount/uploadAttachments）与粘贴副本写入文本/素材节点的 status/generationId/appliedGenerationId/errorMessage 登记为 legacy。旧文档转换须在 `cleanCanvas` 之后进行；未测量的媒体节点几何按 280×240 回退。影响：P2-02（转换）、P2-06（投影回 draggable）、P2-07（固定/粘贴命令化）、P3-06（导入校验）。
- 身份与画布归属按现有 ID 保留。新 ID 用 UUID，不以数组位置、标题或 DOM key 做持久身份。

## C2 命令、回执、错误和幂等

```ts
type CommandKind = "move_nodes" | "patch_nodes" | "add_nodes" | "delete_nodes"
  | "edit_edges" | "register_assets" | "apply_generation" | "rename_canvas" | "batch";
type CanvasCommand = {
  schemaVersion: 1; commandId: string; actorId: string; actorSeq: number;
  canvasId: string; storageEpoch: string; baseRevision: number;
  kind: CommandKind; payload: unknown;
};
type Delta = {
  canvasId: string; fromRevision: number; revision: number;
  nodes: NodeSummary[]; documents: DocumentRecord[]; edges: EdgeRecord[];
  removedNodeIds: string[]; removedDocumentIds: string[]; removedEdgeIds: string[];
  assets: unknown[]; name?: string;
};
type CommitReceipt = {
  commandId: string; revision: number; eventSeq: number; storageEpoch: string;
  changedNodeIds: string[]; changedEdgeIds: string[];
  fieldVersions: Array<FieldRef & { version: number }>;
  delta: Delta; replayed: boolean;
};
type CommandErrorCode = "invalid_command" | "field_conflict" | "lease_conflict"
  | "canvas_deleted" | "command_id_reused" | "actor_sequence_gap"
  | "stale_epoch" | "queue_full" | "maintenance" | "storage_unavailable";
```

payload 必须用 Zod discriminatedUnion 严格解析，不能将上面的 unknown 原样传数据库：

| kind | payload 精确形状 | 规则 |
|---|---|---|
| move_nodes | `{items: [{nodeId, expectedVersion, from: Geometry, to: Geometry}]}` | 1..10000，ID不重复，from和版本都匹配；整组原子 |
| patch_nodes | `{items: [{nodeId, field, expectedVersion, value}]}` | 1..1000；field 从节点注册表白名单取，不允许任意 path |
| add_nodes | `{nodes: NodeSummary[], documents: DocumentRecord[]}` | 1..1000；ID预分配，校验类型、几何、document归属 |
| delete_nodes | `{items: [{nodeId, expectedEntityVersion}]}` | 1..10000；连带删入/出边并保留墓碑，不删除仍被引用素材 |
| edit_edges | `{add: EdgeRecord[], remove: [{edgeId, expectedVersion}]}` | 端点同画布；引用角色/槽位使用现有规则 |
| register_assets | `{assets: [{assetName, kind, createdAt, missing?: boolean}]}` | 只登记当前画布归属；物理存在/缺失由受信服务端核验 |
| apply_generation | `{nodeId, generationId, claimId, assets, patch}` | 服务端内部命令；过期结果仅登记素材/orphan，不覆盖新任务 |
| rename_canvas | `{expectedVersion, name}` | 1..160字符；相机属于视图偏好，不借此发布共享几何修改 |
| batch | `{commands: [{kind, payload}]}` | 1..100，不允许嵌套batch；共享外层身份，一个事务/撤销单元 |

- 默认请求字节上限 4MiB，服务端流式计数后解析；不能只信 Content-Length。每条正文≤100000字符，prompt≤12000；超限413，客户端保留待确认操作并提示。
- JSON 数据须有限数字、无循环/undefined/function、无 `__proto__/prototype/constructor` 路径；几何x/y绝对值≤1e9、宽高>0且≤1e6。
- Node 注册字段白名单以四类现有 Node data 类型为准，保留 generationId/results/primaryResultId/参考参数。文本宽高继续受560/1120限制，其他类型不套用文本规则。
- 命令规范化 JSON：递归排序对象键，数组不排序；SHA-256覆盖完整已解析 envelope。相同commandId不同hash返回409 command_id_reused，不执行、不覆盖回执。
- 每个canvas+actor的 actorSeq 从1递增，只允许next或已知重复；缺口409 actor_sequence_gap。客户端单画布一个在途命令。
- baseRevision 落后不直接失败；检查目标字段版本/租约。未变字段无操作时也记录幂等回执，但不增加revision/eventSeq。
- 正式改变一次递增canvas revision，数据+回执+一个canvas事件同事务。重复请求返回原回执，replayed=true，不追加事件。
- 服务接口 `executeCommand(command, context): Promise<CommitReceipt>`；context中的origin/actor权限由服务器注入，不接受payload里的管理员标记。
- `apply_generation` 和迁移内部命令不向通用HTTP客户端开放。普通patch不可改claims/上游requestId等服务字段。
- 400参数错，404画布删除，409字段/身份冲突，423租约/维护，429队列满，503存储不可用；返回结构 `{error:{code,message,fields?,retryAfterMs?}}`。禁止HTTP200包裹未保存失败。
- JSON兼容阶段允许整文件写，但普通调用已通过新命令；旧diff只留导入/旧API边界。P3完成后不允许正常SQL命令加载整个CanvasDoc。

## C3 手势、历史、outbox和切换

- `beginGesture(ids)` 缓存参与者的起始几何与geometryVersion；`updateGesture`只改覆盖；`finishGesture`产生一个move_nodes。移回起点不产生无效历史。
- 途中每250ms最多写一次坐标检查点，最终立即收敛；已有geometry-journal语义保留，不能改成每帧文档clone。
- 租约键为canvasId+nodeId+field；field包括geometry/content/prompt。TTL=4000ms，续期=1000ms；释放必须匹配owner+leaseToken。失焦/隐藏/取消释放，超时兜底。
- 活跃手势不应用远端同geometry补丁：暂存并在结束后比较版本；不同字段立即应用。冲突可见，不静默选本地或远端。
- 历史保存命令前值和提交后字段版本，不保存整张画布。undo是一条新的条件命令；任何字段所有权改变则整条undo拒绝，不能半撤销群组。
- redo基于undo产生的新版本，仍有前置条件。Agent后续字段、素材结果不能随用户历史回滚。
- 客户端actorId持久于独立会话存储，actorSeq和命令在IndexedDB同事务分配。不能刷新后复用旧actorId但序号回到1。
- IndexedDB升级为v2，增加 `outbox`（复合key=[canvasId,actorId,actorSeq]）、`checkpoints`、`client_state`；保留v1 drafts用于一次恢复转换。
- outbox项形状 `{command,state:"queued"|"sent"|"conflict",createdAt,bytes}`。sent载荷/ID不可改；queued同字段可合并，保留最早before和最新after。
- 收到确认后，仅删除该commandId以及明确覆盖的checkpoint cutoff；写receipt水位、删outbox和清checkpoint同事务。
- 重试只重发相同sent envelope；不能换ID掩盖不明结果。收费网络请求不属于outbox自动重试对象。
- outbox上限1000项或16MiB。达到阈值时不丢已接收修改，暂停新增后台写入并提示；下一次新编辑在接受前明确拒绝，不假保存。
- quota/损坏/旧草稿恢复失败时保留原记录和当前工作态，阻止切画布/退出成功提示；提供导出恢复包。不得清库解除保护。
- 切换storageEpoch必须先排空或安全导出旧epoch outbox。离线旧epoch客户端恢复时先进入兼容重放协调，不把旧命令直接写新主库。
- v1全量草稿转换只允许在加载恢复时使用diff；转换完成的outbox与标记同事务后才清旧草稿。

## C4 SQLite、Worker与运行边界

- `better-sqlite3`唯一默认驱动；P3-01锁定一个经验证的精确版本，不升级其他依赖。内置node:sqlite只用于研究对照，不能隐式fallback。
- 一个数据目录一个长驻DB Worker，`globalThis`内按canonical dataDir持有服务单例，路由bundle不得重复new Worker。
- 生产worker用独立构建的 `.cjs` 入口；不要依赖Electron直接解释TypeScript。迁移 `.sql` 是运行资源而非仅源码。
- `DbRequest={requestId,op,args}`；`DbResponse={requestId,ok,result?,error?}`。op为固定白名单：health/query/command/migrate/backup/maintenance，query再映射repository名称，HTTP端不接收任意SQL。
- Worker队列最多128请求/16MiB，单请求4MiB；交互请求超时5s，busy_timeout=2000ms；备份/迁移独立维护任务最长60s并提供进度，不在主UI线程执行。
- 配置WAL、foreign_keys=ON、synchronous=FULL；启动读取sqlite_version()与compile_options，版本至少3.51.3。失败阻断迁移，不降低可靠性配置。
- 所有写事务同步完成，禁止async事务回调、fetch、下载、图片解码、等待模型。文件处理完成后才登记资产。
- Worker退出立即拒绝在途请求，结果未知命令按原ID恢复查询；不得重新收费生成。明确关闭时await checkpoint/close并释放单例。
- Node开发、standalone、Windows Electron各输出runtime、modules ABI、driver版本、SQLite版本、worker路径、native路径、建表写入/重启读取/backup结果。
- 包内Electron服务使用process.execPath的内置Node，不能拿系统node执行一次冒充Electron ABI验证。
- `.next`与自定义distDir通过同一buildRoot解析器；desktop prepare/finish只处理自己的新staging，不复用旧产物。
- 依赖脚本默认禁用；仅受控执行better-sqlite3/Electron必要的安装或rebuild，记录实际产物，禁止全局放开全部生命周期。

## C5 表、查询和事务职责

以下是最低必需表/约束；字段类型在P3-03/04的迁移SQL中固定。所有外部ID保留为TEXT，版本/序号INTEGER，时间用UTC字符串。删除墓碑是显式状态。

| 表 | 主键与主要字段/索引 |
|---|---|
| projects | id PK, name, created_at；默认项目default-project |
| canvases | id PK, project_id FK, name, revision, name_version, storage_epoch, deleted_at |
| nodes | PK(canvas_id,id), type,schema_version,x,y,width,height,entity_version,geometry_version,document_id,data_json,deleted_at；索引(canvas_id,type) |
| documents | PK(canvas_id,id), node_id UNIQUE per canvas, content, version；FK(canvas_id,node_id) |
| node_fields | PK(canvas_id,node_id,field), version；保存name/prompt等非几何字段版本 |
| edges | PK(canvas_id,id), source,target,role,version,deleted_at；复合FK端点同canvas；入/出索引 |
| assets | asset_name PK, relative_path,kind,bytes,sha256,width,height,duration,status；媒体不存BLOB |
| canvas_assets | PK(canvas_id,asset_name),created_at,missing；独立归属，不能全局可见 |
| asset_derivatives | PK(asset_name,variant,source_hash),relative_path,status,error；variant为thumb256/thumb1024/poster |
| generation_records | asset_name PK, schema_version,snapshot_json,saved_at；保留不可变真实上游生成信息 |
| agent_conversations | PK(canvas_id,id),title,settings_json,created_at,updated_at；分页 |
| agent_messages | PK(canvas_id,conversation_id,id),ordinal,parts_json,created_at；同会话ordinal唯一 |
| task_runs | task_id PK,canvas_id,node_id,generation_id,upstream_id,state,snapshot_json,remote_url,result_json,error,claim_released,updated_at |
| tool_calls | PK(run_id,tool_call_id),canvas_id,phase,event_seq,command_id,mapping_json,error,updated_at |
| generation_claims | PK(canvas_id,node_id),claim_id,state,task_id,expires_at |
| edit_leases | PK(canvas_id,node_id,field),owner,token,expires_at |
| canvas_events | PK(canvas_id,event_seq),revision,command_id,delta_json,created_at；index(canvas_id,revision) |
| command_receipts | command_id PK,canvas_id,actor_id,actor_seq,request_hash,receipt_json,created_at；UNIQUE(canvas_id,actor_id,actor_seq) |
| actor_watermarks | PK(canvas_id,actor_id),accepted_seq,ack_seq,retired_before,storage_epoch |
| legacy_operation_ids | PK(canvas_id,operation_id)；旧ID全量保留，不因缺少hash而自动允许重放 |
| workspace_preferences | key PK,value_json；最后画布/每画布相机偏好，非共享命令 |
| schema_migrations | version PK,checksum,applied_at；已执行版本checksum改变即拒绝启动 |
| import_runs | id PK,source_digest,status,cursor,report_json；恢复导入而非重复覆盖 |
| backup_manifests | id PK,revision_manifest_json,media_manifest_json,status,created_at |

- Node document_id可空；先插node再document并更新关联，使用同事务避免循环FK插入顺序问题。复合FK启用，不能只在JS校验。
- SQL move只UPDATE几何/version及相关event/receipt，禁止SELECT documents.content或UPDATE data_json。
- patch按字段读改，动态列名来自硬编码白名单；用户字段名永不拼接SQL。
- list summaries不SELECT正文；详情分页50项、总JSON响应≤256KiB；长文走document分块接口，每块≤16000字符。
- JSON兼容阶段的CanvasDoc只是转换边界；SQL内部repository以实体查询，不返回完整图给命令执行器。
- 导入/导出可以全图校验，普通命令只校验目标实体、关联边、受影响引用下游。
- 不做实际媒体GC首发：孤儿标记并生成报告，活跃任务/备份引用一律保留。物理回收需另行用户授权。

## C6 迁移、备份、事件和水位

迁移输入清单必须包含：`canvases/*.json`、`agent/*.json`、`video-tasks/*.json`、`generations/*.json`、`app-state.json`、`assets/`元数据；排除OAuth/auth文件。Canvas的libraryAssets/appliedOperationIds/generationClaims都必须转入对应表。

- 迁移状态：idle → preparing → importing → validating → ready_to_switch → committed；失败为blocked/failed。写入独立staging DB，源JSON只读。
- preparing先关新写入口、等在途提交、检查所有活跃客户端outbox握手及任务。无法证明没有未确认写入就拒绝切换，不把离线浏览器当已确认。
- source_digest对清单和文件内容计算SHA256，恢复时重新核验。源变化重新准备，不能续写错版本。
- 每文件/批次有import_runs进度；一个坏JSON阻断该次“完整迁移成功”，输出文件和原因；不静默skip。
- 校验数量、关键字段规范化hash、引用完整、外键检查、integrity_check；缺失媒体显式missing，不能伪造存在。
- 切换通过原子替换 `storage-state.json`：`{version:1,backend:"sqlite",epoch,dbFile,importRunId}`。DB完成并关闭staging连接、必要fsync后再发布标记。
- 崩溃在标记前仍用JSON；标记后只用SQLite，SQL启动失败进入恢复提示而非退回旧JSON。
- 旧JSON保留只读，禁止双写。切换后新增数据的回退必须先导出当前SQLite到新的兼容目录并核验，不能直接指回旧目录。
- backup API产生一致性DB快照；从该快照枚举媒体清单，再固定引用/校验复制，记录缺失和hash。备份不直接复制活跃DB主文件。
- restore先在新目录验证schema/version/hash/integrity，再维护切换；绝不覆盖当前活动库。备份夹不得被普通GC处理。
- 变化API：`GET /api/canvases/:id/changes?afterRevision=R&limit=100`返回`{events,fromRevision,toRevision,hasMore,storageEpoch}`；整条事务事件不拆成半个Delta。
- SSE：`GET /api/canvases/:id/events`；id=eventSeq，data带canvasId/revision/commandId/delta。仅活动画布一个连接；切换卸载旧连接。
- 回放每页≤100事件/1MiB，单个合法大事务事件可单独返回≤4MiB并注明oversized；客户端整条验证后原子apply，不分帧发布半张无效图。
- eventSeq按画布单调；工具事件另有run+tool的eventSeq，不与canvas eventSeq混用。
- 缺口先changes补齐；早于保留水位410 snapshot_required，获取同一事务revision的一致性几何快照，正文按需载入，再重放未确认outbox。
- 断线退避1/2/4/8/16/30s+抖动；后台隐藏标签页暂停非必要渲染，保留终态和未确认记录；不恢复常态2s整图轮询。
- 每actor显式ack已安全持久化的连续序号。回执压缩只删≤ack_seq的详细delta，保留accepted_seq/retired_before及身份记录；迟到旧seq返回已退役/需恢复，不重新执行。
- 事件保留最近10000条且至少24小时；活跃客户端未确认水位以内不裁剪，达到64MiB未确认事件上限时背压而非丢事件。墓碑首发不物理删除。
- 退役actor不能在同epoch复用ID从1开始；新actor必须新UUID。旧operation ID始终独立识别，禁止清空后接受迟到旧请求。

## C7 渲染、媒体和后台预算

统一 `runtime-budget.ts` 常量：完整组件80、轻量目标400、进入概览zoom<0.30或候选>500、退出zoom>0.38且候选<350、预取带300屏幕px、后台slice4ms、预显示合并100ms、网络6、解码2、播放器2、主动播放1、应用解码LRU128MiB/3200万像素。

- 优先级gesture > receipt/terminal > visible-content > preview > prefetch/maintenance；rAF不承担全图同步计算。
- 索引返回完整候选几何；常规投影超过上限进入概览，不随意截断造成无提示节点失踪。活跃编辑/拖动/连线起点pin，选择全集只存ID。
- 轻量/完整切换保留真实width/height、handle几何。边按包围盒相交判定，跨屏边两端都不可见也不能漏掉。
- 框选、全选、copy、delete、fit bounds基于完整store/index；超过单命令上限使用可见进度的多批，不能静默只处理可见子集。
- 每个语义大批次原子。指针反馈不降频，后台正文挂载可让出。
- 图片节点/素材库/候选/工具结果共用媒体服务，同asset+variant去重；缩略图长边256/1024，原图仅详情/导出。
- 派生失败留固定占位并可重试；读取旧素材只惰性排队。视频浏览不批量提取poster，首次主动播放后可缓存。
- Abort只取消本消费者；最后订阅者退出才中止共享下载。取消预取不取消收费任务。
- Range支持单range，包括`bytes=0-0`、`bytes=100-`、`bytes=-100`；多range/非法/越界返回416和`Content-Range: bytes */size`，完整请求200，合法206，HEAD无body。
- 响应使用文件流，记录Content-Length/Content-Type/Accept-Ranges/Content-Range；断连关闭句柄，不整文件readFile。
- 64位文件大小/offset必须在JS安全整数范围内；文件名继续用isSafeAssetName和assetPath校验，同源守卫不放松。
- Markdown缓存key=documentId+version，轻量摘要最多512字符；完整编辑原文无损，块阅读有界；跨组件保留IME/草稿/滚动。
- 已完成消息稳定缓存，分页每50条；不因历史窗口化切断活动流控制器或工具结果配对。

## C8 Agent 生命周期与工具查询

- 执行：input-streaming → validating → queued → executing → committed；错误blocked/failed/cancelled/unknown。blocked有原因，解除后重新校验才可回queued。
- 呈现：preview → shell-ready → content-loading → ready/load-failed。load-failed不修改执行committed。
- 事件 `{canvasId,runId,toolCallId,eventSeq,phase,entityIds,commandId?,revision?,completed?,total?,unit?}`；仅真实计数，不猜百分比或内部推理。
- 阶段通过SDK `data-*`/transient与持久tool_calls记录驱动，逐token不入DB。先读安装版AI SDK类型，不能照旧SDK教程写不存在的回调。
- preview key=`toolCallId:itemIndex`，只提取SDK已解析partial-input的完整字段；正文预览≤512字符，100ms合并，终态立即处理。
- 完整输入校验后一次分配真实ID并持久mapping；重试复用mapping。服务端位置是最终事实，预显示不先修改正式node。
- add预览、edit标记、delete待删除标记均不进入引用/素材/撤销；成功原位接替，失败清临时层；用户相机只在点击“定位到结果”后移动。
- `read_canvas`返回revision、类型数量和最多50节点摘要，不返回长正文/内部claims/所有消息。
- `get_canvas_nodes`按ID最多50；`search_canvas_nodes`按类型/名称/区域分页；`read_canvas_neighborhood`按入/出边分页；`read_document_chunk`每块16000字符。
- 所有工具JSON结果≤64KiB，详情正文总预算32000字符，超限提前停止并返回cursor/truncated/remaining，不在序列化之后截坏JSON。
- 中文搜索首版名称规范化contains，参数化SQL `instr(normalized_name, ?)`，最多50结果；长正文搜索按document分页、限制预算，不谎称FTS默认分词解决中文短词。
- cursor包含查询hash/画布/revision/最后排序键，坏cursor400、revision变化返回明确restart，不跨画布复用。
- 保留新增20、编辑30、连线40、小批工具、并发1和12步上限；检查当前agent配置再移植，不提高工具并发。
- 已发上游任务结果未知只查询原requestId；没有requestId则unknown待人工，不自动新建generationId重发。取消请求不等于取消收费已成功。
- UI取消预览/请求与后台任务终止分开记录，执行记录和generationClaims必须保持可恢复。

## C9 测试、开关与发布

- feature配置集中于 `lib/canvas-runtime/features.ts`。JSON阶段可关闭新scene/preview；SQLite切换后渲染降级仍读SQLite，不能因UI开关倒回JSON。
- 每Issue测试进入package.json的全量入口；新增专项脚本用 `test:commands/test:db/test:sync/test:media/test:agent-runtime/test:performance`，缺失脚本由首次使用任务创建。
- Node测试使用node:test和隔离数据目录；组件测试确有需要时锁定react-test-renderer为当前React相同版本，或用合成adapter测试+人工渲染验证，不能安装不兼容major。
- 三端驱动测试用真正目标runtime；数据库事务测试用临时SQLite，不用mock SQL证明原子性。
- 迁移/故障使用临时目录、合成媒体、mock上游；用户真数据与OAuth文件完全排除。
- 性能目标：100/1000/5000/10000混合节点、2N边、100KB长文；帧p95≤20ms/p99≤50ms、pointer-to-paint p95≤50ms、事件到可见p95≤200ms、几何首交互≤2s、局部commit p95≤100ms。
- rAF间隔不等于pointer-to-paint；Node单测耗时不等于浏览器帧率；GitHub共享runner耗时不是指定硬件达标证据。
- 60分钟每秒2批20节点mock写入使用有界滚动实体集和真实更新/删除，不允许无界增长负载本身混淆泄漏判断；另测短时纯增长压力。
- 最终由用户提供/确认真实拖动和桌面验收，未测写未测；CI不自动签收人工项目，不自动发Release/部署/合并main。
