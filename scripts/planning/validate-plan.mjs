import { readFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { loadPlan, indexIssues, validatePullRequest, validateEvidence, reachableTestScripts } from './plan-lib.mjs';
import { githubApi, listAll } from './publish-issues.mjs';

const { manifest } = await loadPlan();
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const scripts = reachableTestScripts(packageJson.scripts);
if (!scripts.includes('tests/workstation-plan.test.mjs')) throw new Error('规划回归测试尚未进入pnpm test');
console.log(`规划校验通过：${manifest.tasks.length}任务，${manifest.tasks.reduce((n, t) => n + t.dependsOn.length, 0)}依赖，推荐执行顺序无冲突。`);

if (process.argv.includes('--pr')) {
  if (!process.env.GITHUB_EVENT_PATH) throw new Error('PR验证需要GitHub事件上下文');
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  if (!pr || pr.base.repo.full_name !== manifest.repository || pr.base.ref !== manifest.integrationBranch) throw new Error('PR目标仓库/集成分支不符');
  const { taskId, issueNumber } = validatePullRequest(pr.body, manifest);
  const task = manifest.tasks.find(item => item.id === taskId);
  const api = githubApi();
  const issues = indexIssues(await listAll(api, `/repos/${manifest.repository}/issues?state=all`));
  if (issues.get(taskId)?.number !== issueNumber) throw new Error('Task-ID与Closes Issue不一致');
  for (const dep of task.dependsOn) {
    const issue = issues.get(dep);
    if (!issue || issue.state !== 'closed' || issue.state_reason !== 'completed') throw new Error(`依赖尚未完成：${dep}`);
    // 证据须已存在于目标基线，不能在本PR里伪造前置任务完成。
    const evidencePath = `docs/workstation-plan/evidence/${dep}.json`;
    const raw = execFileSync('git', ['show', `${pr.base.sha}:${evidencePath}`], { encoding: 'utf8' });
    const depEvidence = JSON.parse(raw);
    validateEvidence(manifest.tasks.find(item => item.id === dep), depEvidence);
    execFileSync('git', ['merge-base', '--is-ancestor', depEvidence.sourceCommit, pr.base.sha]);
  }
  const evidence = JSON.parse(await readFile(`docs/workstation-plan/evidence/${taskId}.json`, 'utf8'));
  validateEvidence(task, evidence);
  execFileSync('git', ['merge-base', '--is-ancestor', evidence.sourceCommit, 'HEAD']);
  for (const file of task.requiredTests) {
    await access(file);
    if (!scripts.includes(file) && !scripts.includes('tests/*.test.mjs')) throw new Error(`专项测试未加入pnpm test：${file}`);
  }
  console.log(`PDCA结构、完成证据及直接依赖校验通过：${taskId} / #${issueNumber}。人工证据真实性仍需维护者签收。`);
}
