import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadPlan, validateManifest, extractTaskSection, indexIssues, replaceManaged } from './plan-lib.mjs';

export async function listAll(api, path) {
  const result = [];
  for (let page = 1; page <= 100; page++) {
    const items = await api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(items)) throw new Error(`列表响应无效：${path}`);
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw new Error('列表超过安全分页上限，请缩小发布范围');
}

export async function publishPlan({ manifest, documents, repo, ref, api, checkpoint = async () => {} }) {
  validateManifest(manifest, documents);
  if (repo !== manifest.repository) throw new Error('发布仓库必须是规划指定的用户fork');
  if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error('发布必须绑定完整提交SHA');
  const root = `/repos/${repo}/issues`;
  const issues = indexIssues(await listAll(api, `${root}?state=all`));
  const docUrl = name => `https://github.com/${repo}/blob/${ref}/docs/workstation-plan/${name}`;
  const shared = `规划版本：[${ref.slice(0, 8)}](https://github.com/${repo}/commit/${ref})。\n\n必读：[总计划](${docUrl('README.md')}) · [共享契约](${docUrl('contracts.md')}) · [PDCA协议](${docUrl('protocol.md')}) · [交接提示词](${docUrl('prompts.md')})。\n\n只实施本Issue；直接依赖须完成并合入 \`${manifest.integrationBranch}\`。每个Check逐条给出真实证据；缺手测保持开放。一个PR只关闭本Issue，不合并main、不收费生成、不迁移真实数据。\n\n`;
  async function save(id, title, content, label) {
    let current = issues.get(id);
    if (!current) {
      const body = replaceManaged('', id, content);
      if (body.length > 60000) throw new Error(`Issue正文超限：${id}`);
      current = await api('POST', root, { title, body, labels: [label] });
    } else {
      // 更新前重读，保留发布期间人工追加在托管区块外的内容。
      current = await api('GET', `${root}/${current.number}`);
      const body = replaceManaged(current.body ?? '', id, content);
      if (body.length > 60000) throw new Error(`Issue正文超限：${id}`);
      if (body !== current.body) current = await api('PATCH', `${root}/${current.number}`, { body });
    }
    issues.set(id, current);
    await checkpoint({ repository: repo, ref, issues: Object.fromEntries([...issues].map(([key, value]) => [key, { number: value.number, id: value.id, url: value.html_url }])) });
    return current;
  }
  const parentContent = () => {
    const table = manifest.recommendedOrder.map(id => {
      const task = manifest.tasks.find(t => t.id === id); const issue = issues.get(id);
      const deps = task.dependsOn.map(dep => issues.has(dep) ? `#${issues.get(dep).number} (${dep})` : dep).join('、') || '无';
      return `| ${id} | ${issue ? `#${issue.number}` : '逻辑任务'} ${task.title} | ${deps} | ${task.manual ? '需要' : '按本包平台/命令要求'} |`;
    }).join('\n');
    return `${shared}## 执行总览\n\n${manifest.tasks.length}个独立叶子任务，按依赖逐一推进；本Issue只在P6-04最终签收后关闭。\n\n| Task-ID | 子Issue | 直接依赖 | 人工交互 |\n|---|---|---|---|\n${table}\n\n## 分批与边界\n\n${documents['README.md']}`;
  };
  // 重跑时等全部身份可用后再更新总表，不反复改写为中间状态。
  if (!issues.has('ROOT')) await save('ROOT', manifest.parentTitle, parentContent(), 'documentation');
  const taskContent = task => {
    const deps = task.dependsOn.map(id => issues.has(id) ? `- [ ] #${issues.get(id).number}（${id}）已完成并合入集成分支` : `- [ ] ${id} 已完成并合入集成分支`).join('\n') || '无前置任务。';
    return `${shared}Task-ID: ${task.id}\n\n父Issue：#${issues.get('ROOT').number}\n\n## 依赖闸门\n\n${deps}\n\n${extractTaskSection(documents[task.spec], task.id)}\n\n## 完成证据\n\n- [ ] 专用测试、类型检查、全量回归和要求的构建/平台检查通过。\n- [ ] PDCA的红灯、绿灯、修正、复验已写入证据。\n- [ ] ${task.manual ? '用户人工交互证据已确认，不能仅凭CI关闭。' : '本任务要求的非交互/平台证据齐全。'}\n- [ ] PR仅关闭本Issue，合入集成分支后再标completed。\n\n证据文件：\`docs/workstation-plan/evidence/${task.id}.json\`。\n章节来源：[${task.spec}](${docUrl(task.spec)})。`;
  };
  for (const task of manifest.tasks) if (!issues.has(task.id)) await save(task.id, `[${task.id}] ${task.title}`, taskContent(task), task.id === 'G0' ? 'documentation' : 'enhancement');
  for (const task of manifest.tasks) await save(task.id, `[${task.id}] ${task.title}`, taskContent(task), 'enhancement');
  const parent = await save('ROOT', manifest.parentTitle, parentContent(), 'documentation');
  const childrenPath = `${root}/${parent.number}/sub_issues`;
  const children = new Set((await listAll(api, childrenPath)).map(i => i.id));
  for (const task of manifest.tasks) {
    const issue = issues.get(task.id);
    if (!children.has(issue.id)) { await api('POST', childrenPath, { sub_issue_id: issue.id }); children.add(issue.id); }
    const dependenciesPath = `${root}/${issue.number}/dependencies/blocked_by`;
    const existing = new Set((await listAll(api, dependenciesPath)).map(i => i.id));
    for (const dep of task.dependsOn) {
      const target = issues.get(dep);
      if (!existing.has(target.id)) { await api('POST', dependenciesPath, { issue_id: target.id }); existing.add(target.id); }
    }
  }
  // 再读取原生关系，不能仅凭POST成功声称完整发布。
  const actualChildren = new Set((await listAll(api, childrenPath)).map(i => i.id));
  for (const task of manifest.tasks) {
    const issue = issues.get(task.id);
    if (!actualChildren.has(issue.id)) throw new Error(`缺少父子关联：${task.id}`);
    const actual = new Set((await listAll(api, `${root}/${issue.number}/dependencies/blocked_by`)).map(i => i.id));
    for (const dep of task.dependsOn) if (!actual.has(issues.get(dep).id)) throw new Error(`缺少依赖关系：${task.id} ← ${dep}`);
  }
  return { repository: repo, ref, verified: true, parent: { number: parent.number, url: parent.html_url }, tasks: manifest.tasks.map(task => ({ taskId: task.id, number: issues.get(task.id).number, url: issues.get(task.id).html_url, dependsOn: task.dependsOn })) };
}

export function githubApi() {
  return async (method, path, body) => {
    if (method !== 'GET') await delay(1000);
    const args = ['api', path, '--method', method, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
    if (body !== undefined) args.push('--input', '-');
    const result = execFileSync(process.env.GH_BIN || 'gh', args, { encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body), maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
    return result.trim() ? JSON.parse(result) : null;
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { manifest, documents } = await loadPlan();
  if (!process.argv.includes('--publish')) {
    console.log(JSON.stringify({ dryRun: true, repository: manifest.repository, tasks: manifest.tasks.length, dependencies: manifest.tasks.reduce((n, t) => n + t.dependsOn.length, 0) }));
  } else {
    const repo = process.env.GITHUB_REPOSITORY || manifest.repository;
    const ref = process.env.GITHUB_SHA || execFileSync(process.env.GIT_BIN || 'git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await mkdir('artifacts/workstation-plan', { recursive: true });
    const checkpoint = state => writeFile('artifacts/workstation-plan/publish-checkpoint.json', `${JSON.stringify(state, null, 2)}\n`);
    const result = await publishPlan({ manifest, documents, repo, ref, api: githubApi(), checkpoint });
    await writeFile('artifacts/workstation-plan/issue-map.json', `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  }
}
