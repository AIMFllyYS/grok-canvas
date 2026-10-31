# 云端起点

## G0 云端干净基线与遗留验收登记

### Plan
- 目标：让后续Agent不依赖任何本地未提交文件或私人文档即可开工。
- 代码起点：业务基线5825e780f6c63544910c69458a0acd3120035b35及后续规划/CI提交，位于origin/feat/workstation-performance。
- 当前已知：240项Node单测和typecheck在本机通过；P0/P1实机trace与桌面体验未签收，不冒充已完成。
- 阅读：本目录README/protocol/contracts、package.json、next.config、CI、tests/canvas-performance.test.mjs。
- 新增交付：`docs/workstation-plan/evidence/G0.json`，仅记录真实CI和人工未测清单。
- 不改业务代码；如云端基线失败先定位并单独说明最小修复，不能带着失败进入P2。

### Do
1. 干净checkout集成分支，不复制本机node_modules/.next/环境变量/账户目录。
2. pnpm10.33.2按lockfile安装，检查规划验证器、所有测试、typecheck和production构建实际输出。
3. 查看Windows/Node22/Node24的CI结果与构建artifact是否成功，不只看workflow已启动。
4. 检查父子Issues、所有blocked-by关系与manifest一致；任何缺失应重跑幂等发布器，而不是手工猜编号。
5. 登记仍未测：实际拖动帧率、pointer-to-paint、Electron安装、60分钟长稳、SQLite（未实施）。
6. 确认新节点/渲染隔离/坐标检查点测试文件在云端存在，普通模型可从README找到对应契约。
7. 写证据文件，red=null并说明仅复现基线；无需为纯记录任务伪造红灯。

### Check
- `node scripts/planning/validate-plan.mjs`：依赖无环、推荐顺序合法、34任务章节齐全。
- `node --test tests/workstation-plan.test.mjs`：发布器幂等/人工内容保护/依赖/PDCA验证通过。
- `pnpm typecheck`、`pnpm test`、CI隔离生产构建成功；测试数取实际值。
- 父Issue含34子Issue，manifest每条边有对应blocked-by；Issue全文中文无乱码，代码与契约链接指向实际发布SHA。
- `.env`、真实用户数据、原始私密计划、媒体/数据库未进入提交。

### Act
- 在G0附云端workflow与commit链接、当前测试数、未测清单；通过后由维护者关闭，解锁P2-01。
- 后续首个实施任务是P2-01，不直接跳SQLite切换或LOD。
- 基线CI通过只代表机器回归，不抵消P6的人工/性能/三端闸门。
