/* Execute the workflow's actual preflight with synthetic GitHub responses only. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const workflow = fs.readFileSync(require.resolve('../.github/workflows/deploy.yml'), 'utf8');
const guard = workflow.match(/    if: >-\n([\s\S]*?)    runs-on:/)[1].trim();
const script = workflow.match(/          script: \|\n([\s\S]*?)      - uses: actions\/checkout/)[1]
  .split('\n').map((line) => line.startsWith('            ') ? line.slice(12) : line).join('\n');
const rolloutStep = workflow.match(/      - name: Recheck current main before automatic ECS rollout\n([\s\S]*?)      - name: Deploy the API task/)[1];
const rolloutScript = rolloutStep.split('          script: |\n')[1]
  .split('\n').map((line) => line.startsWith('            ') ? line.slice(12) : line).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const current = 'a'.repeat(40);
const role = 'arn:aws:iam::123456789012:role/synthetic-deploy';

function jobAllowed(event, { arn = role, result = 'success', upstream = 'push', branch = 'main', ref = 'refs/heads/main' } = {}) {
  const github = { ref, event_name: event, event: { workflow_run: { conclusion: result, event: upstream, head_branch: branch } } };
  return new Function('github', 'vars', `return ${guard};`)(github, { AWS_ROLE_ARN: arn });
}

async function preflight({ event = 'workflow_run', arn = role, change = {}, main = current, triggered = 42 } = {}) {
  const outputs = {}; const calls = [];
  const run = { id: 42, conclusion: 'success', status: 'completed', event: 'push', head_branch: 'main',
    head_repository: { full_name: 'cloud-project-mobility/make_drive_mate' }, path: '.github/workflows/ci.yml', head_sha: current, ...change };
  const github = { rest: { actions: { getWorkflowRun: async () => { calls.push('run'); return { data: run }; } },
    repos: { getBranch: async () => { calls.push('main'); return { data: { commit: { sha: main } } }; } } } };
  const context = { eventName: event, repo: { owner: 'cloud-project-mobility', repo: 'make_drive_mate' }, payload: { workflow_run: { id: triggered } } };
  await new AsyncFunction('github', 'context', 'core', 'process', script)(github, context,
    { setOutput: (key, value) => { outputs[key] = value; } }, { env: { CI_RUN_ID: '42', AWS_ROLE_ARN: arn } });
  return { outputs, calls };
}

test('automatic trigger and job guard require successful main push with connected role', () => {
  assert.match(workflow, /workflow_run:\n    workflows: \[DriveMate CI\]\n    types: \[completed\]\n    branches: \[main\]/);
  assert.match(workflow, /CI_RUN_ID: \$\{\{ github.event_name == 'workflow_run' && github.event.workflow_run.id \|\| inputs.ci_run_id \}\}/);
  assert.equal(jobAllowed('workflow_run'), true);
  for (const options of [{ arn: '' }, { result: 'failure' }, { upstream: 'pull_request' }, { upstream: 'workflow_dispatch' }, { branch: 'feature' }, { ref: 'refs/heads/feature' }]) {
    assert.equal(jobAllowed('workflow_run', options), false);
  }
  assert.equal(jobAllowed('workflow_dispatch', { arn: '' }), true);
});

test('automatic preflight verifies triggered run and current main; manual keeps explicit run selection', async () => {
  assert.deepEqual((await preflight()).outputs, { revision: current, run_id: '42' });
  await assert.rejects(preflight({ main: 'b'.repeat(40) }), /no longer current main/);
  await assert.rejects(preflight({ triggered: 43 }), /identity does not match/);
  const manual = await preflight({ event: 'workflow_dispatch', main: 'b'.repeat(40) });
  assert.deepEqual(manual.calls, ['run']);
});

test('missing role fails manual preflight clearly and untrusted CI still cannot deploy', async () => {
  await assert.rejects(preflight({ event: 'workflow_dispatch', arn: '' }), /AWS_ROLE_ARN is not configured/);
  for (const change of [{ event: 'pull_request' }, { event: 'workflow_dispatch' }, { conclusion: 'failure' },
    { status: 'in_progress' }, { head_branch: 'feature' }, { path: '.github/workflows/other.yml' },
    { head_repository: { full_name: 'other/repo' } }, { head_sha: 'invalid' }]) {
    await assert.rejects(preflight({ change }), /Only a successful main push/);
  }
});

test('automatic rollout rechecks main after image preparation; manual rollout skips this check', async () => {
  assert.match(rolloutStep, /if: github.event_name == 'workflow_run'/);
  assert.ok(workflow.indexOf('Build or reuse the immutable source image') < workflow.indexOf('Recheck current main before automatic ECS rollout'));
  const execute = async (sha) => new AsyncFunction('github', 'context', 'process', rolloutScript)(
    { rest: { repos: { getBranch: async () => ({ data: { commit: { sha } } }) } } },
    { repo: { owner: 'cloud-project-mobility', repo: 'make_drive_mate' } }, { env: { SOURCE_REVISION: current } });
  await execute(current);
  await assert.rejects(execute('b'.repeat(40)), /main changed while the image was being prepared/);
});
