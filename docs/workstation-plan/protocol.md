# 单 Issue PDCA 执行与关闭协议

用户已确认这里是PDCA，不是另一个自定义PADC。每个叶子任务都必须经历Plan→Do→Check→Act；一个Issue可以跨多个会话，但不能缺阶段或把测试交接当成已验证。

## Plan：检查依赖和可执行范围

1. 确认仓库是`AIMFllyYS/grok-canvas`，基于最新`origin/feat/workstation-performance`开`feat/ws-<task-id>`分支。不要从fork默认main或upstream旧代码开工。
2. 读取当前Issue的Task-ID、manifest的直接依赖、共享契约、该任务章节、指定源文件与依赖的Act交接。
3. 依赖Issue必须state=closed且state_reason=completed；同时确认其PR已合入集成分支、实现代码存在。仅关Issue不等于实现存在。
4. 工作区已有无关改动不得覆盖。先记录base SHA、dirty文件、测试基线；不擅自stash/reset用户改动。
5. 在Issue评论写本次范围、文件清单、失败用例、风险、不做事项。当前定义与代码冲突先写证据，不另造协议。
6. 读安装版Next/React Flow/AI SDK相关文档再写对应集成；不能照训练记忆调用旧版本API。

## Do：先红灯，再最小实现

- 先写任务Check要求的失败用例并实际运行，保留命令、退出码、失败断言；构建/测试加载错误不能当功能红灯。
- 完成纯接口的新任务允许第一次因导出不存在失败，但必须再验证测试自身可加载，避免拼错路径形成假红灯。
- 一次修一个行为，复用前置任务接口。不得为让测试过而删断言、skip安全用例、用mock证明真实SQL原子性。
- 不跨任务增加产品功能；非必要重命名/格式化/依赖升级均不做。
- 遇到环境问题先核对版本/依赖/路径，禁止反复执行相同失败操作消耗额度。
- 同一根因三次修改仍不收敛时停止，提供最小复现和冲突契约；不要做第四轮架构猜测。

## Check：独立命令、退出码和证据

按当前任务的专用测试，然后运行以下命令。每条记录独立结果；PowerShell不能把失败后后续成功当总成功。

```text
pnpm typecheck
pnpm test
node --test tests/workstation-plan.test.mjs
node scripts/planning/validate-plan.mjs
git diff --check
```

涉及UI/Next/依赖/运行时/打包时必须生产构建。Windows本地使用：

```powershell
$env:GROK_CANVAS_BUILD_DIR = '.tmp-workstation-check'
pnpm build
$buildExit = $LASTEXITCODE
Remove-Item Env:GROK_CANVAS_BUILD_DIR
if ($buildExit -ne 0) { throw "build failed: $buildExit" }
```

这里仅移除当前shell环境变量，不删除文件。CI使用独立runner默认.next，不与本地dev共享输出。

- 包管理器pnpm10.33.2，安装`pnpm install --frozen-lockfile --ignore-scripts`；native脚本仅按P3-01/02白名单受控执行。
- 本机git不在PATH时可调用安装目录中的git.exe，不修改系统PATH/Git配置。
- 新测试必须进入pnpm test对应套件；全量node glob结果不能替代遗漏了新增文件的pnpm入口修复。
- 真实接口验证携带合法Origin；测试基准端口3210，已有服务占用时不得随意杀进程。运行前核对GROK_CANVAS_PORT：后台终端可能残留3211等覆盖值，导致安全用例失败；在独立测试进程设置3210并复验，不修改同源守卫放行错误端口。
- UI任务另需用户交互确认；没有浏览器/桌面权限记录pending，不能用源码grep冒充真实交互。
- 所有收费API由mock替代，断言上游提交次数。不要因为有真实登录态就发生成测试。
- SQL/native/桌面任务必须执行对应实际运行时的smoke；Node通过不代表Electron通过。
- 性能任务必须记录硬件、负载、SHA、production版本、样本量。缺指标写未测，不能填0。

## Act：修正、签收与下一任务解锁

1. Check失败时保留失败证据，定位根因，最小修正，重跑受影响专测和全量门禁。
2. 写`docs/workstation-plan/evidence/<Task-ID>.json`，只含脱敏结果；附原始CI日志/用户保存trace的引用或hash。
3. 格式见下例；实现提交SHA与证据提交分开，可在实现commit后取得SHA再提交证据。CI会重跑当前PR版本，不能只信旧证据。
4. PR正文必须有单一Task-ID、四个PDCA章节及末尾唯一一条Closes。目标是自己fork的集成分支，不是upstream/main。
5. CI绿色且所需人工/平台证据齐全，才可请求合并；本次交接不授权自动合并。人工同意后用保留实现提交祖先的merge commit合入集成分支，不用squash/rebase改写已记录的sourceCommit。若已有squash，先由维护者核实并修正证据到等价集成SHA，不能伪造祖先检查。
6. GitHub可能不会因非默认分支的Closes自动关闭Issue。核对合入SHA和证据后由维护者关闭为completed，才能解锁依赖。
7. 父Issue须等P6-04最终签收；不能批量关闭未测任务。GitHub关闭理由not_planned不算依赖完成。
8. 每次只推进一个Issue。结束提供下一可执行ID及依赖状态，不自行开启昂贵子代理。

## 证据格式

以下示例只说明结构，值必须来自实际执行，不能照抄SHA、时间、退出码或把示例当验收结果：

```json
{
  "taskId": "P2-01",
  "sourceCommit": "实现代码提交的40位SHA",
  "status": "passed",
  "red": {"command": "node --test tests/command-schema.test.mjs", "exitCode": 1, "assertion": "实际失败断言和原因"},
  "checks": [
    {"command": "pnpm typecheck", "exitCode": 0, "evidence": "CI日志URL或脱敏日志路径"},
    {"command": "pnpm test", "exitCode": 0, "evidence": "CI日志URL或脱敏日志路径"}
  ],
  "manual": {"status": "not-required", "evidence": "本任务不要求人工交互"},
  "act": "实际修正、复验和剩余限制",
  "risks": [],
  "next": "P2-02"
}
```

- status只允许passed/blocked/failed；非passed不能作为完成证据。
- manual.status为passed/pending/not-required。manifest.manual=true时必须passed并有用户证据；CI只能验证字段完整，真实性由维护者签收。
- 仅G0允许red=null，必须在act中说明只复现/整理基线。其余叶子任务都包含新代码或新验证脚本，必须记录实际红灯；只验收的辅助Agent复用实施Agent已有红灯，不伪造新的记录。
- checks至少包含typecheck/test的成功记录；任务要求build/native/长稳的额外检查必须加入，不能因公共字段少就省略。
- 不能上传.env/auth、用户目录完整列表、原始画布/生成提示词/真实素材/数据库；使用合成数据和脱敏路径。

## PR正文最小格式

```text
Task-ID: P2-01

## Plan
范围、依赖与本次代码基线；确认直接依赖已合入集成分支。

## Do
实际修改文件和行为；先失败再实现的证据。

## Check
逐条测试/构建命令→退出码→日志；所需手测/平台/故障证据。

## Act
失败如何修复、复验结果、遗留限制、交接接口、是否等待人工签收。
证据文件：docs/workstation-plan/evidence/P2-01.json

Closes #实际叶子Issue编号
```

- 不关闭父Issue，不在一个PR写多个Closes；Task-ID与Closes指向的Issue标记必须一致。
- CI检查推荐顺序/依赖图和PR结构；未来改动不得删workflow、绕过PDCA或把所有任务manual改为false。
- 代码之外仅改计划/CI的维护PR仍须明确说明目的，不挟带业务变更绕开单Issue约束。
