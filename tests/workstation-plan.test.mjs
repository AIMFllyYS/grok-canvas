import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateManifest, extractTaskSection, replaceManaged, indexIssues, validatePullRequest, validateEvidence, reachableTestScripts } from '../scripts/planning/plan-lib.mjs';
import { publishPlan } from '../scripts/planning/publish-issues.mjs';

const section = id => `## ${id} 测试任务\n\n### Plan\n读取文件和契约，确认依赖。\n### Do\n先失败测试再最小实现。\n### Check\n运行测试并核对退出码。\n### Act\n保存修正和验证证据。\n`;
function fixture() {
  return { manifest: { version: 1, repository: 'AIMFllyYS/grok-canvas', integrationBranch: 'feat/workstation-performance', baselineCommit: 'a'.repeat(40), parentTitle: '总计划', recommendedOrder: ['G0', 'P2-01'], tasks: [
    { id: 'G0', title: '基线', spec: 'bootstrap.md', dependsOn: [], requiredTests: ['tests/base.test.mjs'], manual: false },
    { id: 'P2-01', title: '类型', spec: 'p2.md', dependsOn: ['G0'], requiredTests: ['tests/types.test.mjs'], manual: false },
  ] }, documents: { 'README.md': '# 总控\n', 'protocol.md': '# PDCA\n', 'contracts.md': '# 契约\n', 'prompts.md': '# 提示词\n', 'bootstrap.md': section('G0'), 'p2.md': section('P2-01') } };
}

test('真实规划所有任务有PDCA章节且推荐顺序满足依赖', async () => {
  const root = new URL('../docs/workstation-plan/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  const docs = {};
  for (const file of new Set(['README.md', 'protocol.md', 'contracts.md', 'prompts.md', ...manifest.tasks.map(t => t.spec)])) docs[file] = await readFile(new URL(file, root), 'utf8');
  assert.equal(validateManifest(manifest, docs).length, 34);
});

test('依赖缺失、重复ID、循环和推荐顺序错误都拒绝', () => {
  for (const mutate of [
    m => m.tasks[1].dependsOn.push('P9-99'),
    m => m.tasks.push(m.tasks[0]),
    m => m.tasks[0].dependsOn.push('P2-01'),
    m => m.recommendedOrder.reverse(),
  ]) {
    const { manifest, documents } = fixture(); mutate(manifest);
    assert.throws(() => validateManifest(manifest, documents));
  }
});

test('缺少Check、章节重复或非法文档路径不能通过规划校验', () => {
  const { manifest, documents } = fixture();
  assert.equal(extractTaskSection(documents['p2.md'], 'P2-01').startsWith('## P2-01'), true);
  assert.throws(() => validateManifest(manifest, { ...documents, 'p2.md': documents['p2.md'].replace('### Check', '### Other') }));
  assert.throws(() => extractTaskSection(section('P2-01') + section('P2-01'), 'P2-01'));
  manifest.tasks[1].spec = '../secret.md';
  assert.throws(() => validateManifest(manifest, documents));
});

test('托管Issue区块替换保留人工内容，破损标记拒绝覆盖', () => {
  const old = replaceManaged('', 'P2-01', '旧计划');
  const next = replaceManaged(`人工前言\n${old}\n人工结论`, 'P2-01', '新计划');
  assert.match(next, /^人工前言/); assert.match(next, /人工结论$/); assert.doesNotMatch(next, /旧计划/);
  assert.equal(replaceManaged(next, 'P2-01', '新计划'), next);
  assert.throws(() => replaceManaged('人工已有Issue', 'P2-01', '新计划'));
  assert.throws(() => replaceManaged('<!-- workstation-plan:P2-01:begin -->', 'P2-01', '新计划'));
});

test('重新发布保留托管区块中已勾选的同名验收项', () => {
  const old = replaceManaged('', 'P2-01', '旧说明\n- [x] 已执行专测\n- [ ] 尚未执行');
  const next = replaceManaged(old, 'P2-01', '新说明\n- [ ] 已执行专测\n- [ ] 尚未执行');
  assert.match(next, /- \[x\] 已执行专测/);
  assert.match(next, /- \[ \] 尚未执行/);
});

test('重复发布身份和仿冒PR记录不能成为计划Issue', () => {
  const body = replaceManaged('', 'G0', '正文');
  assert.throws(() => indexIssues([{ number: 1, body }, { number: 2, body }]));
  assert.equal(indexIssues([{ number: 3, body, pull_request: {} }]).size, 0);
});

const prBody = 'Task-ID: P2-01\n\n## Plan\n已核对依赖和修改范围。\n## Do\n实现并保存红灯测试证据。\n## Check\n专测、全量和类型检查成功。\n## Act\n修复边界并再次运行回归。\n\nCloses #2\n';
test('PR必须单Task-ID、四阶段和唯一关闭目标', () => {
  const { manifest } = fixture();
  assert.deepEqual(validatePullRequest(prBody, manifest), { taskId: 'P2-01', issueNumber: 2 });
  assert.throws(() => validatePullRequest(prBody + '\nCloses #3', manifest));
  assert.throws(() => validatePullRequest(prBody.replace('## Check', '## Other'), manifest));
  assert.throws(() => validatePullRequest(prBody.replace('P2-01', 'P2-99'), manifest));
  assert.throws(() => validatePullRequest('Task-ID: G0\n' + prBody, manifest));
  assert.throws(() => validatePullRequest(prBody.replace('已核对依赖和修改范围。', '<!-- 仅模板注释 -->'), manifest));
});

test('证据不允许失败检查、缺失红灯或伪造人工完成', () => {
  const task = fixture().manifest.tasks[1];
  const evidence = { taskId: task.id, sourceCommit: 'a'.repeat(40), status: 'passed', red: { command: 'node --test x', exitCode: 1, assertion: '期望实际拒绝坏字段' }, checks: [
    { command: 'pnpm typecheck', exitCode: 0, evidence: 'CI日志' }, { command: 'pnpm test', exitCode: 0, evidence: 'CI日志' },
  ], manual: { status: 'not-required', evidence: '纯逻辑' }, act: '已修正并复验' };
  assert.doesNotThrow(() => validateEvidence(task, evidence));
  assert.throws(() => validateEvidence(task, { ...evidence, red: null }));
  assert.throws(() => validateEvidence(task, { ...evidence, status: 'blocked' }));
  assert.throws(() => validateEvidence({ ...task, manual: true }, evidence));
  assert.throws(() => validateEvidence(task, { ...evidence, checks: [{ command: 'pnpm test', exitCode: 1, evidence: '失败' }] }));
});

test('测试登记检查只接受pnpm test可达的套件', () => {
  const scripts = { test: 'pnpm test:ui && pnpm test:planning', 'test:ui': 'node --test tests/a.test.mjs', 'test:planning': 'node --test tests/workstation-plan.test.mjs', 'test:unused': 'node --test tests/b.test.mjs' };
  const reachable = reachableTestScripts(scripts);
  assert.match(reachable, /workstation-plan.test.mjs/); assert.doesNotMatch(reachable, /b.test.mjs/);
});

function fakeApi() {
  const issues = []; const children = new Map(); const blocked = new Map(); const writes = [];
  return { issues, writes, children, blocked, api: async (method, url, body) => {
    const root = '/repos/AIMFllyYS/grok-canvas/issues';
    if (method !== 'GET') writes.push({ method, url, body });
    if (url.startsWith(root + '?')) return structuredClone(issues);
    if (method === 'POST' && url === root) {
      const issue = { id: 100 + issues.length, number: issues.length + 1, html_url: `https://github.com/AIMFllyYS/grok-canvas/issues/${issues.length + 1}`, state: 'open', ...body };
      issues.push(issue); return structuredClone(issue);
    }
    const match = url.match(/\/issues\/(\d+)(.*)$/); assert.ok(match, url);
    const issue = issues.find(i => i.number === Number(match[1])); assert.ok(issue);
    const suffix = match[2].split('?')[0];
    if (!suffix && method === 'PATCH') { Object.assign(issue, body); return structuredClone(issue); }
    if (!suffix && method === 'GET') return structuredClone(issue);
    const map = suffix === '/sub_issues' ? children : blocked;
    if (!map.has(issue.number)) map.set(issue.number, new Set());
    const set = map.get(issue.number);
    if (method === 'GET') return structuredClone(issues.filter(i => set.has(i.id)));
    if (method === 'POST') { set.add(body.sub_issue_id ?? body.issue_id); return structuredClone(issue); }
    throw new Error(`意外API ${method} ${url}`);
  } };
}

test('发布两遍不重复创建/关联，也不重开人工关闭任务', async () => {
  const { manifest, documents } = fixture(); const fake = fakeApi();
  const options = { manifest, documents, repo: manifest.repository, ref: 'b'.repeat(40), api: fake.api };
  const first = await publishPlan(options);
  assert.equal(fake.issues.length, 3); assert.equal(first.tasks.length, 2);
  assert.equal(fake.children.get(first.parent.number).size, 2);
  assert.equal(fake.blocked.get(first.tasks[1].number).size, 1);
  fake.issues[1].body += '\n人工验收结论'; fake.issues[1].state = 'closed';
  const before = fake.writes.length;
  await publishPlan(options);
  assert.equal(fake.writes.length, before); assert.equal(fake.issues[1].state, 'closed');
  assert.match(fake.issues[1].body, /人工验收结论/);
});

test('发布中断可再次发现已有任务续跑；禁止误发到upstream', async () => {
  const { manifest, documents } = fixture(); const fake = fakeApi(); let injected = false;
  const options = { manifest, documents, repo: manifest.repository, ref: 'b'.repeat(40), api: async (...args) => {
    if (!injected && args[0] === 'POST' && args[1].endsWith('/dependencies/blocked_by')) { injected = true; throw new Error('模拟断网'); }
    return fake.api(...args);
  } };
  await assert.rejects(publishPlan(options), /模拟断网/);
  await publishPlan(options); assert.equal(fake.issues.length, 3);
  await assert.rejects(publishPlan({ ...options, repo: 'wangxiaosu/grok-canvas' }), /仓库/);
});
