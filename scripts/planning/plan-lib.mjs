import { readFile } from 'node:fs/promises';

const TASK = /^(?:G0|P[2-6]-\d{2})$/;
const text = value => typeof value === 'string' && value.trim().length > 0;
function requireValue(value, message) { if (!value) throw new Error(message); }

export function extractTaskSection(document, id) {
  requireValue(TASK.test(id), `非法任务ID：${id}`);
  const lines = String(document).replaceAll('\r\n', '\n').split('\n');
  const starts = lines.flatMap((line, index) => line.startsWith(`## ${id} `) ? [index] : []);
  requireValue(starts.length === 1, `任务章节缺失或重复：${id}`);
  const start = starts[0];
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('## ')) end++;
  return lines.slice(start, end).join('\n').trim();
}

export function validateManifest(manifest, documents) {
  requireValue(manifest.version === 1, '不支持的规划版本');
  requireValue(manifest.repository === 'AIMFllyYS/grok-canvas', '规划仓库不是用户fork');
  requireValue(manifest.integrationBranch === 'feat/workstation-performance', '集成分支不符');
  requireValue(/^[a-f0-9]{40}$/.test(manifest.baselineCommit), '缺少真实基线SHA');
  requireValue(Array.isArray(manifest.tasks) && manifest.tasks.length > 0, '任务为空');
  const ids = new Set();
  for (const task of manifest.tasks) {
    requireValue(TASK.test(task.id) && !ids.has(task.id), `非法或重复任务：${task.id}`);
    ids.add(task.id);
    requireValue(text(task.title) && /^[a-z0-9-]+\.md$/.test(task.spec), `任务文档路径无效：${task.id}`);
    requireValue(Array.isArray(task.dependsOn) && new Set(task.dependsOn).size === task.dependsOn.length, `依赖重复：${task.id}`);
    requireValue(typeof task.manual === 'boolean', `缺少人工标记：${task.id}`);
    requireValue(Array.isArray(task.requiredTests) && task.requiredTests.length > 0 && task.requiredTests.every(t => /^tests\/[\w/-]+\.test\.mjs$/.test(t)), `测试路径无效：${task.id}`);
    const section = extractTaskSection(documents[task.spec], task.id);
    for (const phase of ['Plan', 'Do', 'Check', 'Act']) requireValue(section.includes(`### ${phase}\n`), `${task.id} 缺少${phase}`);
  }
  for (const name of ['README.md', 'contracts.md', 'protocol.md', 'prompts.md']) requireValue(text(documents[name]), `公共文档缺失：${name}`);
  const ordered = []; const active = new Set(); const visited = new Set();
  const byId = new Map(manifest.tasks.map(task => [task.id, task]));
  function visit(id) {
    requireValue(ids.has(id), `依赖不存在：${id}`);
    requireValue(!active.has(id), `依赖循环：${id}`);
    if (visited.has(id)) return;
    active.add(id);
    for (const dep of byId.get(id).dependsOn) visit(dep);
    active.delete(id); visited.add(id); ordered.push(id);
  }
  for (const id of ids) visit(id);
  const recommendation = manifest.recommendedOrder;
  requireValue(Array.isArray(recommendation) && recommendation.length === ids.size && new Set(recommendation).size === ids.size, '推荐顺序不完整/重复');
  const seen = new Set();
  for (const id of recommendation) {
    requireValue(ids.has(id), `推荐顺序含未知任务：${id}`);
    for (const dep of byId.get(id).dependsOn) requireValue(seen.has(dep), `推荐顺序违反依赖：${id} ← ${dep}`);
    seen.add(id);
  }
  return ordered;
}

export async function loadPlan(directory = new URL('../../docs/workstation-plan/', import.meta.url)) {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  const documents = {};
  for (const name of new Set(['README.md', 'contracts.md', 'protocol.md', 'prompts.md', ...manifest.tasks.map(t => t.spec)])) {
    requireValue(/^[a-z0-9-]+\.md$/i.test(name), '禁止读取规划目录外文件');
    documents[name] = await readFile(new URL(name, directory), 'utf8');
  }
  validateManifest(manifest, documents);
  return { manifest, documents };
}

export function replaceManaged(existing, id, content) {
  requireValue(id === 'ROOT' || TASK.test(id), '托管ID无效');
  const begin = `<!-- workstation-plan:${id}:begin -->`;
  const end = `<!-- workstation-plan:${id}:end -->`;
  if (!existing) return `${begin}\n${content.trim()}\n${end}`;
  requireValue(existing.split(begin).length === 2 && existing.split(end).length === 2, `Issue托管标记破损：${id}`);
  const start = existing.indexOf(begin); const stop = existing.indexOf(end);
  requireValue(stop > start, `Issue托管区块顺序错误：${id}`);
  const checked = new Set([...existing.slice(start, stop).matchAll(/^- \[[xX]\] (.+)$/gm)].map(match => match[1]));
  const preserved = content.trim().replace(/^- \[ \] (.+)$/gm, (line, label) => checked.has(label) ? `- [x] ${label}` : line);
  const block = `${begin}\n${preserved}\n${end}`;
  return existing.slice(0, start) + block + existing.slice(stop + end.length);
}

export function indexIssues(issues) {
  const result = new Map();
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const matches = [...(issue.body ?? '').matchAll(/<!-- workstation-plan:(ROOT|G0|P[2-6]-\d{2}):begin -->/g)];
    requireValue(matches.length <= 1, `Issue #${issue.number} 含多个发布身份`);
    if (!matches.length) continue;
    const id = matches[0][1];
    requireValue(!result.has(id), `重复发布身份：${id}`);
    result.set(id, issue);
  }
  return result;
}

export function validatePullRequest(body, manifest) {
  const normalized = String(body ?? '').replaceAll('\r\n', '\n').replace(/<!--[\s\S]*?-->/g, '');
  const ids = [...normalized.matchAll(/^Task-ID:\s*(\S+)\s*$/gm)];
  requireValue(ids.length === 1 && manifest.tasks.some(t => t.id === ids[0][1]), 'PR必须指定一个已定义Task-ID');
  for (const phase of ['Plan', 'Do', 'Check', 'Act']) {
    const pattern = new RegExp(`^## ${phase}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm');
    requireValue(text(normalized.match(pattern)?.[1]), `PR缺少${phase}证据`);
  }
  const closes = [...normalized.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)];
  requireValue(closes.length === 1 && /\nCloses #\d+\s*$/.test(normalized), 'PR末尾必须唯一Closes目标');
  return { taskId: ids[0][1], issueNumber: Number(closes[0][1]) };
}

export function validateEvidence(task, evidence) {
  requireValue(evidence?.taskId === task.id && evidence.status === 'passed', '证据任务不匹配或尚未通过');
  requireValue(/^[a-f0-9]{40}$/.test(evidence.sourceCommit), '证据缺少实现SHA');
  if (task.id !== 'G0') requireValue(text(evidence.red?.command) && Number.isInteger(evidence.red?.exitCode) && evidence.red.exitCode !== 0 && text(evidence.red.assertion), '开发任务缺少有效红灯');
  requireValue(Array.isArray(evidence.checks) && evidence.checks.every(c => text(c.command) && c.exitCode === 0 && text(c.evidence)), '存在失败或无证据检查');
  for (const command of ['pnpm typecheck', 'pnpm test']) requireValue(evidence.checks.some(c => c.command === command), `缺少${command}`);
  requireValue(text(evidence.act), '缺少Act修正/交接');
  requireValue(['passed', 'not-required'].includes(evidence.manual?.status) && text(evidence.manual.evidence), '人工项目仍未完成');
  if (task.manual) requireValue(evidence.manual.status === 'passed', '本任务必须人工签收');
}

export function reachableTestScripts(scripts) {
  const seen = new Set(); const result = [];
  function visit(name) {
    if (seen.has(name)) return;
    seen.add(name); const command = scripts[name];
    requireValue(text(command), `测试脚本不存在：${name}`);
    result.push(command);
    for (const match of command.matchAll(/\bpnpm\s+(?:run\s+)?([\w:-]+)/g)) visit(match[1]);
  }
  visit('test');
  return result.join('\n');
}
