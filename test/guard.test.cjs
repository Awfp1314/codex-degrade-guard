'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdg-guard-test-'));
const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdg-guard-transcript-'));
process.env.MODEL_DEGRADATION_GUARD_STATE_DIR = stateDir;
process.env.MODEL_DEGRADATION_GUARD_UPDATE_CHECK = '0';

const state = require('../lib/state.cjs');
const guard = require('../hooks/guard.cjs');

test.after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(transcriptDir, { recursive: true, force: true });
});

let transcriptSeq = 0;

function makeTranscript(turnId, assistantText, extraLines = []) {
  transcriptSeq += 1;
  const file = path.join(transcriptDir, `rollout-${transcriptSeq}.jsonl`);
  const lines = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
    ...(assistantText === null ? [] : [{
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: assistantText }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId }
      }
    }]),
    ...extraLines
  ];
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return file;
}

// 一轮 MCP 自检工具调用（Codex 会把它记成 McpToolCall item）。
function mcpSubmitMessage(turnId, fields) {
  return {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      turn_id: turnId,
      item: { type: 'McpToolCall', server: 'model_degradation_guard', tool: 'submit_check', arguments: fields }
    }
  };
}

function preToolInput(sessionId, turnId, transcriptPath, toolName = 'apply_patch', toolInput = { patch: '*** Begin Patch' }) {
  return {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    turn_id: turnId,
    transcript_path: transcriptPath,
    tool_name: toolName,
    tool_input: toolInput
  };
}

function promptInput(sessionId, prompt, turnId = 'turn-prompt') {
  return { hook_event_name: 'UserPromptSubmit', session_id: sessionId, turn_id: turnId, prompt };
}

// 走一轮 UserPromptSubmit 拿到 token，再用 MCP 工具（= state.recordAnswersByToken）提交答案。
function beginTurn(sessionId, turnId, answers) {
  const prompted = guard.handleHook(promptInput(sessionId, '干活', turnId));
  const context = prompted.hookSpecificOutput.additionalContext;
  const token = /token=([A-Za-z0-9_-]+)/.exec(context)[1];
  if (answers) state.recordAnswersByToken(token, answers);
  return token;
}

const NO_LEAK = [/openai/i, /thibault/i, /sottiaux/i, /负责人/, /20\d{2}/, /juice\s*=\s*\d/];

function assertNoLeak(text) {
  for (const pattern of NO_LEAK) {
    assert.doesNotMatch(text, pattern, `注入/拒绝文案不得泄露信息：${pattern}`);
  }
}

test('只读工具直接放行，且不产生状态文件', () => {
  const transcript = makeTranscript('turn-read', '随便说点什么');
  const input = preToolInput('session-read', 'turn-read', transcript, 'Bash', { command: 'rg foo src/' });
  assert.equal(guard.handleHook(input), null);
  assert.equal(fs.existsSync(state.statePath('session-read')), false);
});

test('本轮没提交自检时 deny，文案给出去哪儿提交（含 token），且不泄题', () => {
  const sessionId = 'session-missing';
  const token = beginTurn(sessionId, 'turn-1');
  const transcript = makeTranscript('turn-1', '我先看一下文件内容');

  const output = guard.handleHook(preToolInput(sessionId, 'turn-1', transcript));
  const reason = output.hookSpecificOutput.permissionDecisionReason;
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason, /submit_check/);
  assert.match(reason, new RegExp(`token=${token}`));
  assert.match(reason, /DEGRADE_CHECK tibo=/);
  assertNoLeak(reason.replace(token, ''));
});

test('MCP 提交的 Tibo 失败：暂停并落 degraded 状态', () => {
  const sessionId = 'session-fail';
  beginTurn(sessionId, 'turn-1', { tibo: '我不认识这个人，需要搜索', cutoff: 'refuse', juice: 'none' });
  const transcript = makeTranscript('turn-1', '开始改代码');

  const output = guard.handleHook(preToolInput(sessionId, 'turn-1', transcript));
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assertNoLeak(output.hookSpecificOutput.permissionDecisionReason);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /继续/);

  const saved = state.readState(sessionId);
  assert.equal(saved.status, 'degraded');
  assert.equal(saved.usedDegraded, true);
  assert.equal(saved.last.tibo, 'fail');
  assert.equal(saved.last.reason, 'tibo_fail');
  assert.equal(saved.last.source, 'state');
});

test('Tibo 正确 + 只有截止年金丝雀：放行且不暂停', () => {
  const sessionId = 'session-canary';
  beginTurn(sessionId, 'turn-1', {
    tibo: 'Thibault Sottiaux 是 OpenAI 的工程负责人，不需要搜索',
    cutoff: '2024-06',
    juice: '128'
  });
  const transcript = makeTranscript('turn-1', '开始干活');
  assert.equal(guard.handleHook(preToolInput(sessionId, 'turn-1', transcript)), null);

  const saved = state.readState(sessionId);
  assert.equal(saved.status, 'healthy');
  assert.equal(saved.usedDegraded, false);
  assert.equal(saved.last.cutoff, 'canary');
});

test('Tibo 含糊 + 2024-06 + juice=0：暂停', () => {
  const sessionId = 'session-combo';
  beginTurn(sessionId, 'turn-1', { tibo: 'Thibault Sottiaux 我记不清了', cutoff: '2024-06', juice: '0' });
  const transcript = makeTranscript('turn-1', '继续');
  const output = guard.handleHook(preToolInput(sessionId, 'turn-1', transcript));
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(state.readState(sessionId).last.reason, 'tibo_ambiguous_with_canary');
});

test('transcript 里的 MCP 工具调用可以充当答案（状态没写成功时的兜底）', () => {
  const sessionId = 'session-transcript';
  beginTurn(sessionId, 'turn-1');
  const transcript = makeTranscript('turn-1', '开始干活', [
    mcpSubmitMessage('turn-1', {
      token: 'whatever',
      tibo: 'Thibault Sottiaux is OpenAI personnel',
      cutoff: 'refuse',
      juice: '64'
    })
  ]);
  assert.equal(guard.handleHook(preToolInput(sessionId, 'turn-1', transcript)), null);
  assert.equal(state.readState(sessionId).last.source, 'mcp');
});

test('旧的正文打卡行仍然兼容（MCP 不可用时的兜底）', () => {
  const sessionId = 'session-legacy';
  beginTurn(sessionId, 'turn-1');
  const transcript = makeTranscript('turn-1', 'DEGRADE_CHECK tibo=我不认识这人 cutoff=refuse juice=none');
  const output = guard.handleHook(preToolInput(sessionId, 'turn-1', transcript));
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(state.readState(sessionId).last.source, 'legacy_line');
});

test('用户回复「继续」后本会话放行，之后不再阻断', () => {
  const sessionId = 'session-approve';
  beginTurn(sessionId, 'turn-1', { tibo: '不认识', cutoff: 'refuse', juice: 'none' });
  assert.equal(
    guard.handleHook(preToolInput(sessionId, 'turn-1', makeTranscript('turn-1', '动手'))).hookSpecificOutput.permissionDecision,
    'deny'
  );

  const approved = guard.handleHook(promptInput(sessionId, '继续', 'turn-2'));
  assert.match(approved.hookSpecificOutput.additionalContext, /submit_check/);
  assert.equal(state.readState(sessionId).status, 'degraded_approved');

  // 同一情形的后续 write 不再被拦。
  state.recordAnswersByToken(
    state.readState(sessionId).check.token,
    { tibo: '我还是不认识', cutoff: 'refuse', juice: 'none' }
  );
  assert.equal(guard.handleHook(preToolInput(sessionId, 'turn-2', makeTranscript('turn-2', '继续动手'))), null);
  assert.equal(state.readState(sessionId).status, 'degraded_approved');
});

test('放行后即使换成另一种降智情形也不阻断，但继续记录', () => {
  const sessionId = 'session-approve-other';
  beginTurn(sessionId, 'turn-1', { tibo: '不认识', cutoff: 'refuse', juice: 'none' });
  guard.handleHook(preToolInput(sessionId, 'turn-1', makeTranscript('turn-1', '动手')));
  guard.handleHook(promptInput(sessionId, '继续', 'turn-2'));

  state.recordAnswersByToken(
    state.readState(sessionId).check.token,
    { tibo: 'Thibault Sottiaux 我说不准', cutoff: '2024-06', juice: '0' }
  );
  assert.equal(guard.handleHook(preToolInput(sessionId, 'turn-2', makeTranscript('turn-2', '继续动手'))), null);

  const saved = state.readState(sessionId);
  assert.equal(saved.status, 'degraded_approved');
  assert.equal(saved.usedDegraded, true);
  assert.equal(saved.last.reason, 'tibo_ambiguous_with_canary');
});

test('放行后本轮没提交也不阻断', () => {
  const sessionId = 'session-approve-empty';
  beginTurn(sessionId, 'turn-1', { tibo: '不认识', cutoff: 'refuse', juice: 'none' });
  guard.handleHook(preToolInput(sessionId, 'turn-1', makeTranscript('turn-1', '动手')));
  guard.handleHook(promptInput(sessionId, '继续', 'turn-2'));

  beginTurn(sessionId, 'turn-2');
  assert.equal(guard.handleHook(preToolInput(sessionId, 'turn-2', makeTranscript('turn-2', '我直接开始改代码'))), null);
});

test('没有暂停时，用户随口说「继续」不会把状态改成已批准', () => {
  const sessionId = 'session-healthy';
  beginTurn(sessionId, 'turn-1', { tibo: 'Thibault Sottiaux is OpenAI personnel', cutoff: 'refuse', juice: '64' });
  guard.handleHook(preToolInput(sessionId, 'turn-1', makeTranscript('turn-1', '动手')));
  guard.handleHook(promptInput(sessionId, '继续', 'turn-2'));
  assert.equal(state.readState(sessionId).status, 'healthy');
});

test('过载：只提示，不阻断写', () => {
  const sessionId = 'session-capacity';
  beginTurn(sessionId, 'turn-1');
  const transcript = makeTranscript('turn-1', null, [
    { type: 'error', message: 'Selected model is at capacity. Please try a different model.' }
  ]);
  const output = guard.handleHook(preToolInput(sessionId, 'turn-1', transcript));
  assert.equal(output.hookSpecificOutput, undefined);
  assert.match(output.systemMessage, /过载|capacity/i);
  assert.equal(state.readState(sessionId).status, 'overloaded');
});

test('读不到 transcript 时失败放行', () => {
  const input = preToolInput('session-nofile', 'turn-1', path.join(transcriptDir, 'missing.jsonl'));
  assert.equal(guard.handleHook(input), null);
  assert.equal(guard.handleHook(preToolInput('session-nopath', 'turn-1', null)), null);
});

test('模型把旧的打卡行写进工具入参也算报过', () => {
  const sessionId = 'session-toolinput';
  beginTurn(sessionId, 'turn-1');
  const transcript = makeTranscript('turn-1', '我先动手');
  const input = preToolInput(sessionId, 'turn-1', transcript, 'Bash', {
    command: "Write-Output 'DEGRADE_CHECK tibo=Thibault Sottiaux is OpenAI personnel cutoff=refuse juice=32'; Remove-Item a.txt"
  });
  assert.equal(guard.handleHook(input), null);
});

// 造一个「降智已放行、已经写过 N 个回合」的会话状态。
function seedDegradedWrites(sessionId, turns) {
  const current = state.defaultState(sessionId);
  current.status = 'degraded_approved';
  current.usedDegraded = true;
  current.firstDegradedAt = 1789400000000;
  current.degradedWriteTurns = turns;
  current.lastWriteTurnId = `turn-${turns}`;
  current.wroteDegradedAt = 1789400000000;
  state.writeState(current, 1789400000000);
  return current;
}

function stop(sessionId, extra = {}, now) {
  const input = { hook_event_name: 'Stop', session_id: sessionId, turn_id: 'turn-stop', ...extra };
  return now === undefined ? guard.handleHook(input) : guard.handleHook(input, now);
}

// 让「距上次提醒的时间」可控：状态里 warnedAt 用 BASE，测试传 BASE + 1 分钟，避开 30 分钟兜底。
const BASE = 1789400000000;
const SOON = BASE + 60 * 1000;

test('结束提醒：健康会话不提醒，降智但没写过也不提醒', () => {
  assert.equal(stop('session-canary'), null);
  assert.equal(stop('session-fail'), null);
});

test('结束提醒：首次降智写入回合一定提醒，同一回合不重复拦', () => {
  const sessionId = 'session-warn-first';
  seedDegradedWrites(sessionId, 1);

  const first = stop(sessionId);
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /降智/);
  assert.match(first.reason, /质量/);
  assert.match(first.reason, /请勿直接提交/);
  assert.match(first.reason, /原样转达/);
  assert.match(first.reason, /首次命中/);

  const second = stop(sessionId);
  assert.equal(second.decision, undefined);
  assert.match(second.systemMessage, /降智/);
});

test('结束提醒：默认每 5 个降智写入回合再提醒一次', () => {
  const sessionId = 'session-warn-every5';
  seedDegradedWrites(sessionId, 1);
  assert.equal(stop(sessionId, {}, BASE).decision, 'block');

  // 首次提醒发生在第 1 个写入回合；之后要再过 5 个写入回合（第 6 个）才提醒。
  for (const turns of [2, 3, 4, 5]) {
    const current = seedDegradedWrites(sessionId, turns);
    current.warnedAt = BASE;
    current.warnedWriteTurns = 1;
    state.writeState(current, BASE);
    assert.equal(stop(sessionId, {}, SOON).decision, undefined, `第 ${turns} 个写入回合不该提醒`);
  }

  const current = seedDegradedWrites(sessionId, 6);
  current.warnedAt = BASE;
  current.warnedWriteTurns = 1;
  state.writeState(current, BASE);
  assert.equal(stop(sessionId, {}, SOON).decision, 'block', '距上次提醒满 5 个写入回合时应再次提醒');
});

test('结束提醒：30 分钟兜底（期间有新增写入才提醒）', () => {
  const sessionId = 'session-warn-interval';
  const base = 1789400000000;
  const input = { hook_event_name: 'Stop', session_id: sessionId, turn_id: 't' };
  const seed = (turns, warnedTurns) => {
    const current = seedDegradedWrites(sessionId, turns);
    current.warnedAt = base;
    current.warnedWriteTurns = warnedTurns;
    state.writeState(current, base);
  };

  // 距上次提醒还没到 30 分钟，且没到 5 轮：不提。
  seed(2, 1);
  assert.equal(guard.handleHook(input, base + 10 * 60 * 1000).decision, undefined);
  // 超过 30 分钟且期间有新增写入：兜底提醒。
  assert.equal(guard.handleHook(input, base + 31 * 60 * 1000).decision, 'block');

  // 关掉兜底后不再按时间提醒。
  const previous = process.env.MODEL_DEGRADATION_GUARD_WARN_MIN_INTERVAL_MS;
  process.env.MODEL_DEGRADATION_GUARD_WARN_MIN_INTERVAL_MS = '0';
  try {
    seed(3, 2);
    assert.equal(guard.handleHook(input, base + 60 * 60 * 1000).decision, undefined);
  } finally {
    if (previous === undefined) delete process.env.MODEL_DEGRADATION_GUARD_WARN_MIN_INTERVAL_MS;
    else process.env.MODEL_DEGRADATION_GUARD_WARN_MIN_INTERVAL_MS = previous;
  }
});

test('结束提醒：WARN_EVERY_TURNS=1 每个写入回合都提醒，=0 退化成每会话一次', () => {
  const previous = process.env.MODEL_DEGRADATION_GUARD_WARN_EVERY_TURNS;
  try {
    process.env.MODEL_DEGRADATION_GUARD_WARN_EVERY_TURNS = '1';
    const sessionId = 'session-warn-every1';
    seedDegradedWrites(sessionId, 1);
    assert.equal(stop(sessionId).decision, 'block');

    const next = seedDegradedWrites(sessionId, 2);
    next.warnedAt = BASE;
    next.warnedWriteTurns = 1;
    state.writeState(next, BASE);
    assert.equal(stop(sessionId, {}, SOON).decision, 'block', '=1 时每轮都提醒');

    process.env.MODEL_DEGRADATION_GUARD_WARN_EVERY_TURNS = '0';
    const onceId = 'session-warn-once';
    seedDegradedWrites(onceId, 1);
    assert.equal(stop(onceId).decision, 'block');
    const many = seedDegradedWrites(onceId, 9);
    many.warnedAt = BASE;
    many.warnedWriteTurns = 1;
    state.writeState(many, BASE);
    assert.equal(stop(onceId, {}, SOON).decision, undefined, '=0 时只提醒一次');
  } finally {
    if (previous === undefined) delete process.env.MODEL_DEGRADATION_GUARD_WARN_EVERY_TURNS;
    else process.env.MODEL_DEGRADATION_GUARD_WARN_EVERY_TURNS = previous;
  }
});

test('结束提醒：stop_hook_active 为真时不再拦（防环）', () => {
  const sessionId = 'session-warn-active';
  seedDegradedWrites(sessionId, 3);
  assert.equal(stop(sessionId, { stop_hook_active: true }).decision, undefined);
});

test('markWriteAllowed 按回合计数：同一回合多次写只加一', () => {
  const current = state.defaultState('session-count');
  current.usedDegraded = true;
  guard.markWriteAllowed(current, 'turn-a', 1000);
  guard.markWriteAllowed(current, 'turn-a', 1001);
  assert.equal(current.degradedWriteTurns, 1);
  guard.markWriteAllowed(current, 'turn-b', 1002);
  assert.equal(current.degradedWriteTurns, 2);

  const healthy = state.defaultState('session-count-healthy');
  guard.markWriteAllowed(healthy, 'turn-a', 1000);
  assert.equal(healthy.degradedWriteTurns, 0);
});

test('UserPromptSubmit 每轮都注入 token 与自检要求，文案不泄题', () => {
  const output = guard.handleHook(promptInput('session-inject', '帮我重构这个模块', 'turn-inject'));
  const context = output.hookSpecificOutput.additionalContext;
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(context, /submit_check/);

  const token = /token=([A-Za-z0-9_-]+)/.exec(context)[1];
  assert.equal(state.readState('session-inject').check.token, token);
  assert.equal(state.readState('session-inject').check.turnId, 'turn-inject');
  assert.match(context, /tibo=<一句话> cutoff=<YYYY-MM 或 refuse> juice=<数字或 none>/);
  assertNoLeak(context.replace(new RegExp(token, 'g'), ''));
  assert.match(context, /不要联网|不要搜索/);
});

test('每轮 token 会刷新，上一轮的答案不会串到下一轮', () => {
  const sessionId = 'session-token-rotate';
  const first = beginTurn(sessionId, 'turn-1', { tibo: 'Thibault Sottiaux is OpenAI personnel', cutoff: 'refuse', juice: '32' });
  const second = beginTurn(sessionId, 'turn-2');
  assert.notEqual(first, second);
  assert.equal(state.answersForCurrentCheck(state.readState(sessionId)), null);

  const transcript = makeTranscript('turn-2', '动手');
  assert.equal(
    guard.handleHook(preToolInput(sessionId, 'turn-2', transcript)).hookSpecificOutput.permissionDecision,
    'deny'
  );
});

test('MODEL_DEGRADATION_GUARD_DISABLE=1 时探针子会话内钩子停用', () => {
  const previous = process.env.MODEL_DEGRADATION_GUARD_DISABLE;
  process.env.MODEL_DEGRADATION_GUARD_DISABLE = '1';
  try {
    assert.equal(guard.isDisabled(), true);
  } finally {
    if (previous === undefined) delete process.env.MODEL_DEGRADATION_GUARD_DISABLE;
    else process.env.MODEL_DEGRADATION_GUARD_DISABLE = previous;
  }
  assert.equal(guard.isDisabled(), false);
});

test('钩子入口文件可以直接从 stdin 运行', async () => {
  const { spawnSync } = require('node:child_process');
  const sessionId = 'session-e2e';
  const token = beginTurn(sessionId, 'turn-e2e', { tibo: '不认识', cutoff: 'refuse', juice: 'none' });
  const transcript = makeTranscript('turn-e2e', '动手');
  const payload = JSON.stringify(preToolInput(sessionId, 'turn-e2e', transcript));
  const env = { ...process.env, MODEL_DEGRADATION_GUARD_STATE_DIR: stateDir };

  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'guard.cjs')], {
    input: payload, encoding: 'utf8', env
  });
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout.trim()).hookSpecificOutput.permissionDecision, 'deny');

  const promptRun = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'guard.cjs')], {
    input: JSON.stringify(promptInput(sessionId, '再来一轮', 'turn-next')), encoding: 'utf8', env
  });
  assert.equal(promptRun.status, 0);
  const injected = JSON.parse(promptRun.stdout.trim()).hookSpecificOutput.additionalContext;
  assert.match(injected, /token=/);
  assert.notEqual(/token=([A-Za-z0-9_-]+)/.exec(injected)[1], token);

  const disabled = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'guard.cjs')], {
    input: payload, encoding: 'utf8', env: { ...env, MODEL_DEGRADATION_GUARD_DISABLE: '1' }
  });
  assert.equal(disabled.status, 0);
  assert.equal(disabled.stdout.trim(), '');
});
