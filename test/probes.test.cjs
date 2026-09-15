'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// 状态目录必须在 require 之前设定，否则 lib/state.cjs 会锁住默认目录。
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdg-probes-state-'));
process.env.MODEL_DEGRADATION_GUARD_STATE_DIR = stateDir;

const sessionState = require('../lib/state.cjs');

const { agentMessages, buildExecArgs, runCodexExec, shouldRetryWithoutHooks } = require('../probes/lib.cjs');
const { keywordHints, statusFromRun, findBrowser, screenshotHtml, stageReferenceImage, parseArgs, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, DEFAULT_PELICAN_TIMEOUT_MS, PROMPT: PELICAN_PROMPT, REFERENCE_IMAGE } = require('../probes/pelican.cjs');
const { runAll, summarize, PROMPT: CANDY_PROMPT, ANSWER_PATTERN } = require('../probes/candy.cjs');
const { candySummary, pelicanSummary } = require('../scripts/mcp-server.cjs');

test('鹈鹕关键词只作旁证，不再直接定罪', () => {
  const degradedHint = keywordHints({ paragraph: '我会用内联 SVG 画一只鹈鹕', reasoning: [] });
  assert.ok(degradedHint.some((line) => /旁证/.test(line)));
  const loopHint = keywordHints({ paragraph: '做一个连续循环的骑行动画', reasoning: [] });
  assert.ok(loopHint.some((line) => /循环/.test(line)));
  const healthyHint = keywordHints({ paragraph: '我会做一个踩踏动作的动画', reasoning: [] });
  assert.ok(healthyHint.some((line) => /踩踏/.test(line)));
  assert.deepEqual(keywordHints({ paragraph: '我来创建一个 HTML 文件', reasoning: [] }), []);
});

test('鹈鹕结论看是否生成了画面，不看关键词', () => {
  assert.equal(statusFromRun({ htmlFiles: ['a.html'] }).verdict, 'needs_visual');
  assert.equal(statusFromRun({ htmlFiles: ['a.html'], timedOut: true }).verdict, 'needs_visual');
  assert.equal(statusFromRun({ htmlFiles: [], timedOut: true }).verdict, 'failed');
  assert.equal(statusFromRun({ htmlFiles: [] }).verdict, 'failed');
});

test('鹈鹕单次超时默认 12 分钟', () => {
  assert.equal(DEFAULT_PELICAN_TIMEOUT_MS, 12 * 60 * 1000);
});

test('鹈鹕探针用的是固定原句', () => {
  assert.equal(PELICAN_PROMPT, '创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画');
});

test('鹈鹕默认 gpt-6-astra / medium，命令行可覆盖', () => {
  assert.equal(DEFAULT_MODEL, 'gpt-6-astra');
  assert.equal(DEFAULT_REASONING_EFFORT, 'medium');
  const defaults = parseArgs([]);
  assert.equal(defaults.model, 'gpt-6-astra');
  assert.equal(defaults.reasoningEffort, 'medium');
  const overridden = parseArgs(['--model', 'gpt-5.6-sol', '-r', 'high']);
  assert.equal(overridden.model, 'gpt-5.6-sol');
  assert.equal(overridden.reasoningEffort, 'high');
});

test('本机有 Chrome/Edge 时能给本地 HTML 截图', { skip: !findBrowser() || Boolean(process.env.CI) }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdg-shot-'));
  const html = path.join(dir, 'page.html');
  fs.writeFileSync(html, '<html><body><h1>pelican</h1></body></html>');
  try {
    const shot = screenshotHtml(html);
    assert.equal(shot.error, null, shot.error);
    assert.ok(shot.path && fs.existsSync(shot.path));
    assert.ok(fs.statSync(shot.path).size > 100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('鹈鹕参考图复制到探针临时工作区，避免插件缓存路径无法加载', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdg-reference-'));
  try {
    const staged = stageReferenceImage(dir);
    assert.equal(path.dirname(staged), dir);
    assert.notEqual(staged, REFERENCE_IMAGE);
    assert.deepEqual(fs.readFileSync(staged), fs.readFileSync(REFERENCE_IMAGE));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('糖果判定：正确答案是独立的 21', () => {
  assert.equal(ANSWER_PATTERN.test('答案是 21 个'), true);
  assert.equal(ANSWER_PATTERN.test('需要 21'), true);
  assert.equal(ANSWER_PATTERN.test('需要 121 个'), false);
  assert.equal(ANSWER_PATTERN.test('需要 210 个'), false);
});

test('糖果汇总：正确少于 3 次就是降智', () => {
  const row = (index, correct, truncated) => ({
    index, correct, truncated, reasoningTokens: truncated ? 516 : 800,
    outputTokens: 100, elapsedMs: 1000, preview: '', failure: null
  });
  assert.equal(summarize([row(1, true), row(2, true), row(3, true), row(4, false), row(5, false)]).verdict, 'healthy');
  assert.equal(summarize([row(1, true), row(2, true), row(3, false), row(4, false), row(5, false)]).verdict, 'degraded');
  assert.equal(summarize([row(1, true), row(2, false), row(3, false), row(4, false), row(5, false)]).verdict, 'degraded');
  assert.equal(summarize([row(1, false), row(2, false), row(3, false), row(4, false), row(5, false)]).verdict, 'degraded');
  assert.equal(summarize([row(1, true), row(2, true), row(3, true)]).verdict, 'healthy');
  assert.equal(summarize([row(1, true), row(2, false), row(3, true)]).verdict, 'inconclusive');
  assert.equal(summarize([row(1, false)]).verdict, 'inconclusive');
  assert.equal(summarize([row(1, false), row(2, false)]).verdict, 'inconclusive');
  const failed = summarize([{ index: 1, failure: 'boom' }]);
  assert.equal(failed.verdict, 'inconclusive');
  assert.equal(failed.graded, 0);
});

test('糖果探针用的是固定原句', () => {
  assert.match(CANDY_PROMPT, /不使用任何外部工具回答以下问题/);
  assert.match(CANDY_PROMPT, /最少取出多少个糖果/);
});

test('探针统一用空会话，并关掉用户配置里的钩子', () => {
  const args = buildExecArgs({ model: 'gpt-x', reasoningEffort: 'high' });
  assert.deepEqual(args.slice(0, 3), ['exec', '--json', '--skip-git-repo-check']);
  assert.equal(args.includes('--ephemeral'), true);
  assert.equal(args.join(' ').includes('--disable memories'), true);
  assert.equal(args.join(' ').includes('--disable hooks'), true);
  assert.equal(args.join(' ').includes('-m gpt-x'), true);
  assert.equal(args.join(' ').includes('model_reasoning_effort=high'), true);

  const withoutHooks = buildExecArgs({ disableHooks: false });
  assert.equal(withoutHooks.join(' ').includes('--disable hooks'), false);
});

test('老版本 Codex 不认识 hooks 开关时降级重试', () => {
  assert.equal(shouldRetryWithoutHooks('Error: Unknown feature flag: hooks'), true);
  assert.equal(shouldRetryWithoutHooks(''), false);
  assert.equal(shouldRetryWithoutHooks('Selected model is at capacity.'), false);
});

// ── 探针并行/超时（曾出过真 bug：spawnSync 阻塞导致 2 路并行退化成串行）──

function writeStub(dir, sleepSeconds) {
  if (process.platform === 'win32') {
    const file = path.join(dir, 'fake-codex.cmd');
    fs.writeFileSync(file, `@echo off
ping -n ${sleepSeconds + 1} 127.0.0.1 >nul
echo {"type":"item.completed","item":{"type":"agent_message","text":"stub ok"}}
`);
    return file;
  }
  const file = path.join(dir, 'fake-codex.sh');
  fs.writeFileSync(file, `#!/bin/sh
sleep ${sleepSeconds}
echo '{"type":"item.completed","item":{"type":"agent_message","text":"stub ok"}}'
`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('两次 runCodexExec 并发时真的重叠（不是串行）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdg-stub-'));
  const previous = process.env.MODEL_DEGRADATION_GUARD_CODEX_BIN;
  process.env.MODEL_DEGRADATION_GUARD_CODEX_BIN = writeStub(dir, 1);
  try {
    const started = Date.now();
    const [first, second] = await Promise.all([
      runCodexExec({ prompt: 'x', timeoutMs: 30000 }),
      runCodexExec({ prompt: 'x', timeoutMs: 30000 })
    ]);
    const elapsed = Date.now() - started;
    assert.equal(first.exitCode, 0, first.stderr);
    assert.equal(second.exitCode, 0, second.stderr);
    assert.deepEqual(agentMessages(first.events).length, 1);
    // 串行会是 ~2s；真的并行应该明显小于 2s。
    assert.ok(elapsed < 1800, `两次 1s 的运行耗时 ${elapsed}ms，看起来仍是串行`);
  } finally {
    if (previous === undefined) delete process.env.MODEL_DEGRADATION_GUARD_CODEX_BIN;
    else process.env.MODEL_DEGRADATION_GUARD_CODEX_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('单次超时会被杀掉并标记失败，而不是一直挂着', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdg-stub-'));
  const previous = process.env.MODEL_DEGRADATION_GUARD_CODEX_BIN;
  process.env.MODEL_DEGRADATION_GUARD_CODEX_BIN = writeStub(dir, 10);
  try {
    const started = Date.now();
    const run = await runCodexExec({ prompt: 'x', timeoutMs: 800 });
    const elapsed = Date.now() - started;
    assert.equal(run.timedOut, true);
    assert.match(run.failure, /超时/);
    assert.ok(elapsed < 5000, `超时后 ${elapsed}ms 才返回`);
  } finally {
    if (previous === undefined) delete process.env.MODEL_DEGRADATION_GUARD_CODEX_BIN;
    else process.env.MODEL_DEGRADATION_GUARD_CODEX_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('糖果并行调度：2 路并发确实同时开跑', async () => {
  const active = new Set();
  let maxActive = 0;
  const runner = async (index) => {
    active.add(index);
    maxActive = Math.max(maxActive, active.size);
    await new Promise((resolve) => setTimeout(resolve, 40));
    active.delete(index);
    return { index, correct: true, truncated: false, reasoningTokens: 100, outputTokens: 10, elapsedMs: 40, preview: '', failure: null };
  };
  const results = await runAll(5, { runOne: runner });
  assert.equal(results.length, 5);
  assert.equal(maxActive, 2, '最多只应同时跑 2 个');
  assert.deepEqual(results.map((row) => row.index), [1, 2, 3, 4, 5]);
});

test('MCP 摘要带结论与关键数据', () => {
  const pelican = pelicanSummary({
    verdict: 'needs_visual',
    reasons: ['请看画面'],
    htmlFiles: ['/tmp/a.html'],
    screenshot: '/tmp/a.png',
    referenceImage: '/tmp/ref.png',
    elapsedMs: 12345,
    model: 'gpt-6-astra',
    reasoningEffort: 'medium'
  });
  assert.match(pelican, /参考图/);
  assert.match(pelican, /\/tmp\/ref\.png/);
  assert.match(pelican, /\/tmp\/a\.png/);
  assert.match(pelican, /\/tmp\/a\.html/);
  assert.match(pelican, /我不再替你判定/);
  assert.doesNotMatch(pelican, /鹈鹕骑车测试：疑似降智/);

  const candy = candySummary({
    summary: { verdict: 'healthy', correct: 4, graded: 5, truncated: 0 },
    results: [{ index: 1, correct: true, reasoningTokens: 700, preview: '答案是 21' }]
  });
  assert.match(candy, /未见降智/);
  assert.match(candy, /正确 4\/5/);
});

test('MCP 服务：initialize / tools/list / 未知工具 / submit_check / 探针失败', async () => {
  // 准备一个待填写的会话状态（模拟 UserPromptSubmit 发了 token）。
  const pending = sessionState.defaultState('mcp-session');
  sessionState.startCheck(pending, { turnId: 'turn-1', token: 'tok-mcp' }, Date.now());
  sessionState.writeState(pending, Date.now());

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'mcp-server.cjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MODEL_DEGRADATION_GUARD_STATE_DIR: stateDir,
      MODEL_DEGRADATION_GUARD_CODEX_BIN: path.join(__dirname, 'no-such-codex-binary')
    }
  });

  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.resume();

  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'submit_check', arguments: { token: 'bad-token', tibo: 'x', cutoff: 'refuse', juice: '1' } }
    },
    {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: {
        name: 'submit_check',
        arguments: { token: 'tok-mcp', tibo: 'Thibault Sottiaux is OpenAI personnel', cutoff: 'refuse', juice: '64' }
      }
    },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'pelican_probe', arguments: {} } }
  ].map((message) => JSON.stringify(message)).join('\n') + '\n');

  await done;

  try {
    const replies = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(replies[0].result.serverInfo.name, 'model-degradation-guard');
    assert.deepEqual(
      replies[1].result.tools.map((tool) => tool.name),
      ['submit_check', 'pelican_probe', 'candy_probe']
    );
    assert.equal(replies[2].error.code, -32602);
    assert.equal(replies[3].result.isError, true, '无效 token 应报错');
    assert.equal(replies[4].result.isError, false);
    assert.match(replies[4].result.content[0].text, /已记录/);

    const saved = sessionState.readState('mcp-session');
    assert.equal(saved.answers.tibo, 'Thibault Sottiaux is OpenAI personnel');
    assert.equal(saved.answers.juice, '64');

    assert.equal(replies[5].result.isError, true);
    assert.match(replies[5].result.content[0].text, /pelican_probe 失败/);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
