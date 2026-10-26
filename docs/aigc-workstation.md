# AIGC 工作台：架构与验收

## 产品结构

默认进入统一创作画布，右下角展开 Agent；另有导演台制作视图。Agent 不再是独立模式。每个导演台有独立项目 ID、关联画布 ID、简报、素材、完整导演脚本、固定参考库、分镜、对话与制作事件。画布原有的手动节点与节点位置保留。

现有项目是 Next.js App Router + React 19，本机 API 复用 Grok OAuth，媒体与画布保存在文件系统。`app/page.tsx` 仍承接原画布的保存、切换与恢复，新工作台通过 `components/studio/studio-workspace.tsx` 组合它；没有再建立一套相互隔离的媒体库。

- Agent：Vercel AI SDK 7 `ToolLoopAgent`，最多 18 步、串行工具、生成请求不自动重试；AI Elements 对话/工具组件适配 Base UI，Streamdown 处理中文 Markdown、代码与增量文字动画。
- 导演台：唯一顶部栏内用一个视图选择器切换简报、剧本、素材、分镜、成片。没有第二排阶段导航、作品大标题区或底部状态栏。分镜包含连续时间节拍、运镜、引用、独立旁白、修改意见、图片和视频历史。
- 画布：文本、提示词参数、图片、视频和导演流程节点。添加操作集中在一个菜单内，新节点自动避开已有卡片。提示词连线加入实际生成参数，不占图片附件名额；重试保持原请求快照。MP4 上传与成片复用原有 VideoNode 播放器，支持拖动。切换画布时同步 Agent 的项目关联。
- 外观：默认中性纸面，保留黑白与墨黑主题。控件 8px、节点 12px、浮窗 16px 圆角；正文 12–13px、辅助文字 10–11px。自绘 Agent 图形使用镜框与笔画结构，推理摘要使用路径图形；不使用机器人、星形或脑形图标。
- 边缘面板：作品列表从左边缘按需打开，可固定、关闭或拖动调宽；镜头列表可拖动调宽。键盘方向键同样可调，宽度保存在本机，缩窗时限制在窗口范围内。中间和右侧独立滚动，并保留细滚动条。固定侧栏在窄屏自动收起，重新打开时仍显示完整导航。

## 代码入口

| 层 | 入口与职责 |
| --- | --- |
| 工作台 | `components/studio/`：模式、项目、导演台、分镜表单、悬浮 Agent 与工作流预览；`components/pre/`：生产原子组件；`app/workstation.css`：共享设计变量、紧凑样式与响应式布局；`/pre`、`/playbook`：同一生产组件的交互预览 |
| Agent 协议 | `app/api/studio/chat/route.ts`：SDK UI 流、消息校验、停止与恢复；`lib/studio/agent.ts`：所有项目工具 |
| 创作约束 | `lib/studio/schema.ts` 与 `prompts.ts`：双语字段、动作节拍、统一风格/负面约束、来源边界 |
| 制作执行 | `lib/studio/production.ts`、`batch.ts`：脚本、参考图、分镜、视频、检索与分析；长批次在单个流式工具内逐项推进 |
| 恢复与成片 | `media.ts`、`video-submit.ts`：上游请求日志；`video-frames.ts`：采样；`export.ts`：FFmpeg 合成 |
| 共享画布 | `lib/studio/canvas.ts`：将项目映射成 React Flow 节点、连线，复用 `lib/canvas-store.ts` 的 revision 保存 |
| 既有能力 | `lib/xai/`：OAuth 与请求鉴权；`lib/assets.ts`：媒体；`lib/video-tasks.ts` 与 `video-runtime.ts`：持久视频任务 |

Agent 使用 SDK 的工具参数校验、18 步边界和单工具并发；`produce_project` 在一个工具内报告较长的批次进度，避免大项目按图片数量耗尽模型步骤。项目制作锁、消息 ID 规范化、中断工具结果修复和 revision 冲突处理共同保证停止、刷新与下一次对话可以继续。

## 会话、上下文与审批

每个项目支持独立会话、新建与历史切换；旧 messages 无损迁移为原有对话。完整 UI 历史保存在项目中，校验与持久化先于模型连接，登录或模型失败也保留用户输入。

复用 AI SDK 7 的 `validateUIMessages`、`ToolLoopAgent`、`prepareStep`、`pruneMessages` 与 `generateText`：剔除旧推理、压缩旧工具结果，接近保守字符预算时生成旧对话摘要，保留最近四轮用户对话。字符预算不是精确 token 统计；单轮过大或旧历史超出单次压缩预算会明确报错并保留原始历史。没有自建 Agent 循环。SDK 的工具错误保留 input，向下一模型步骤回传错误；不自动重复收费请求。

Agent 内审批使用 `toolApproval: user-approval`、`addToolApprovalResponse` 与 `lastAssistantMessageIsCompleteWithApprovalResponses`；人工拒绝不会执行工具。导演台的直接批准使用同一项目版本校验和制作关卡。脚本、参考图和分镜每次更改都按当前规范判断是否需要重新批准。

输入框使用共享附件标签、Markdown 渲染和模型设置弹层；浮动 Agent 支持指针与键盘移动、调整大小、放大与还原，缩窗会收回可视范围。工具参数中的 Markdown、分析结果与代码共用 MessageResponse。素材库分页、搜索、预览都在受限高度内滚动，打开素材库时 Agent 入口让出翻页位置。

## 共享额度

顶部常驻显示额度与同一行的小刷新按钮；手动刷新绕过一分钟缓存。旧响应显示 creditUsagePercent；统一计费响应显示 prepaidBalance 的原始 credits 值、按需使用和账期。上游未返回订阅已用百分比时不构造百分比，也不把未知显示为 0%。账户切换会重置展示缓存。

## 制作与提示词

参考用户提供的 `D:\projects\My-Skills\aigc-director-workstation Skill 包.zip`。采用稳定参考 ID、全片风格前缀、负面约束末行、中文阅读/英文生成、动作节拍、独立配音和逐镜验收。

使用现有 API 已验证的 6 / 10 / 15 秒时长，不直接使用 Skill 的 8 秒默认值。每个动作节拍必须至少 1 秒，从 0 连续覆盖完整片段。拒绝无效引用、重复 ID、英文提示词中的中文与要求配音/口型的画面指令。

真实视频走分镜首帧，比例跟随首帧，默认 720p 无声。界面中的 @ID 是参考库标签；首帧视频请求会将这些别名转换为描述，不伪装成没有提交的 API 参考槽。

完整脚本与分镜必须先经前端确认批准；批准绑定 scriptVersion，修改脚本、分镜或全片视觉规范后失效。批准后可自动生成缺失参考图。全自动制作按参考图、分镜图、视频顺序补齐缺失产物，保留已有结果；失败项记录原因，继续其他可执行项。停止按钮停止后续提交，当前已提交任务仍保留。人工验收后的镜头才允许合成。

## 存储与恢复

数据保存在 `GROK_CANVAS_DATA_DIR`，默认 `~/.grok-canvas/data`：

- `studio/<id>.json`：项目、对话、版本与事件；串行原子保存。
- `studio-image-jobs/`：图片请求快照、上游结果链接和保存状态。下载中断后恢复同一个链接，不重新调用生成接口；结果未知的请求不自动重发；过期链接需要明确重新生成。
- `studio-video-submissions/`：视频提交日志，收到 request_id 后先保存，再关联本地任务；关联中断可以恢复，结果未知时阻止自动重复提交。
- `video-tasks/`：复用原有视频任务记录，刷新后继续查询与保存；已完成任务不会再次提交。
- `assets/`、`generations/`：复用现有素材和生成记录。

同一导演台的制作操作互斥；编辑使用 revision 乐观锁。画布同步重试冲突，保留用户手动节点与位置。修改参考图、画面规范或镜头时清除下游当前产物/验收状态，历史文件保留；正在生成或已验收的下游视频会阻止不安全的上游修改。

## 真实素材理解与检索

支持 PNG/JPEG/WebP、UTF-8 TXT/Markdown、100MB 以内 MP4。视频上传后用 FFmpeg 抽取 0、2、4 秒关键帧（视频足够长时），视觉分析明确只覆盖采样帧，不声称已处理全部动作或音频。

项目检索返回来源 ID、文件名与原文摘录，中文分词与关键词匹配；这是本地素材检索，不冒充向量数据库。外部图片检索使用 Wikimedia Commons，返回缩略图、来源、作者和授权；网页资料不作为系统指令。

## 运行

常规 `pnpm dev` / `pnpm build` / `pnpm start`，默认仅本机 3210 端口；隔离端测使用 `GROK_CANVAS_PORT` 与 Next 相同的替代回环端口。默认复用 Grok OAuth，文本模型使用 Grok CLI 在线模型目录、本机默认模型与推理强度；在线失败时明确标记缓存来源。Fast 只使用目录中真实提供的变体，不拼造模型 ID。模型、Fast、上下文窗口和推理强度按会话保存。Responses 请求携带本机 CLI 版本与上下文窗口，使用官方 OpenAI Responses provider 的 `forceReasoning` 配置。可选服务端环境变量：`STUDIO_MODEL`、`STUDIO_API_KEY`、`STUDIO_BASE_URL`。密钥不传给浏览器。

`pnpm start` 使用 `scripts/start-production.mjs` 启动 Next standalone 产物，并补齐 standalone 默认不复制的 public 与 static 目录。先完成构建再运行。

Windows 桌面版通过 `pnpm desktop:build` 构建。打包准备阶段只复制 `server.js`、编译后的 `.next`、public 和生产依赖；文件追踪排除本机验收材料、源码、临时目录和旧 release。AI Elements 的来源说明与 Apache 2.0 许可证随安装包分发。

成片合成与视频关键帧依赖系统 FFmpeg；可用 `FFMPEG_PATH` 指定可执行文件。不会自动下载可执行文件。合成逐镜规范化画幅、H.264、24fps、像素格式和时间基准，再按顺序拼接 MP4；相同素材与验收状态重复导出复用已有成片。

开发服务运行时需要单独验证构建，可设置 `GROK_CANVAS_BUILD_DIR=.next.validation` 后构建，避免覆盖当前开发产物。

## 自动化验证

- `pnpm typecheck`
- `pnpm test`：原有回归测试加 `test:studio`。
- `test:studio`：动作节拍与引用校验、提示词、对话 ID、revision 冲突、制作锁、画布保留、图片下载恢复/过期处理、视频提交关联恢复、批量制作进度；有 FFmpeg/ffprobe 时实际制作红蓝两段视频，检查合成后 12 秒、顺序与缓存。
- `scripts/qa-studio.mjs`：在已有 Ego Lite TaskSpace 内检查 Agent 及导演台各页的桌面/手机布局，保存截图与报告，不自行新建其他浏览器。
- `pnpm desktop:smoke`：关闭占用 3210 的本项目服务后运行，启动 `release/win-unpacked` 的实际 Electron 程序，验证默认纸面、创作画布、浮动 Agent、历史入口、预加载桥、单顶部栏和导演台；检查生产组件路由和聊天接口参数校验，保存应用截图，正常关闭窗口后检查随附服务已退出。使用独立数据目录和新浏览器配置，调试端口仅用于这个独立的打包验收进程。

## 已知边界

当前合成无声画面版；旁白、配乐、字幕是独立后期工作。精确逐秒动作和角色一致性取决于生成模型，应在导演台人工验收。没有实现通用网页爬虫、任意命令执行、向量数据库或多用户云端发布。移动端支持 Agent、导演台与共享画布，最小工作区为 320 × 360；复杂多节点编辑仍建议使用较大的窗口。

已进行真实脚本、参考图、分镜图、6 秒视频和最终 MP4 的完整链路测试。验收记录和截图保存于本机 QA 输出目录，详细产物以项目数据与媒体文件为准。

## 2026-10-26 本机验收

使用独立 3211 服务与 `artifacts/ux-qa/data`，保留原有 3210 服务和用户项目。参考图、分镜与视频测试实际调用已连接模型；其余边界由 SDK mock 和持久化回归覆盖。

- `pnpm test` 共 199 项通过，含 SDK 原生工具错误、审批继续、上下文整理、并发保存、媒体恢复和 FFmpeg 合成；`pnpm typecheck` 与生产构建通过。
- EGO 浏览器在 1440 / 768 / 375 宽度检查画布、Agent、简报、剧本、参考图库、分镜、成片，共 21 个布局场景。未发现横向溢出、浮窗越界、破图、页面错误或未处理异常。报告与截图在 `artifacts/ux-qa/layout/`。
- 真实 Grok Agent 完成读取项目、读取画布和新增 Markdown 文本节点；新建会话、历史切换、刷新恢复通过。模型 Fast 请求实际使用 CLI 的 `grok-4.7-build-fast`，上下文窗口和推理强度按会话保存。
- 错误工具调用保留 `referenceId: MISSING`，模型收到脚本未批准错误并解释，未重复调用；停止后可重新发送并收到“恢复成功”。指针拖动与调整 Agent 尺寸、MP4 节点拖动已验证。
- 上传 45 个素材，验证 40 / 5 分页、搜索、长文件名和手机预览；上传 MP4 后同步生成标准 VideoNode。新增文本、提示词参数节点及 Markdown 编辑通过。添加菜单和节点参数面板保持在视口内，参数面板避让底部工具栏。
- 一个 6 秒镜头实际走通脚本修改与批准、参考图生成与确认、分镜、视频、验收、FFmpeg 成片；导出 MP4 为 1280 × 720、约 6.04 秒，浏览器确认可播放。多镜批量与断点恢复有回归覆盖，本次没有另做收费的大规模批量生成。

设计参考来自 Mobbin 的 Lindy/Cohere 执行记录、Dropbox Dash 附件输入、MagicPath 画布菜单与 Mistral 审阅流程；具体来源链接在 `/playbook` 的“交互参考与设计取舍”内。

## v0.2.1 发布验收

版本号为 0.2.1，Windows x64 NSIS 安装包已重新构建；Release 附件包含安装包、blockmap、latest.yml 与 SHA256SUMS.txt。再次通过类型检查和 199 项测试。

实际启动打包后的 Electron，验证默认纸面创作画布、预加载桥、浮动 Agent 可见范围、新建及历史对话入口、导演台单顶部栏、`/pre` 与 `/playbook`；聊天接口正确返回参数校验错误，确认随附 SDK/provider 能够加载。正常关闭应用后随附服务退出，退出码 0。本机证据在 `artifacts/release-0.2.1/`。
