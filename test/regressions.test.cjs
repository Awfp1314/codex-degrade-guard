'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdg-regression-'));
process.env.MODEL_DEGRADATION_GUARD_STATE_DIR = dir;
process.env.MODEL_DEGRADATION_GUARD_UPDATE_CHECK = '0';
const state = require('../lib/state.cjs');
const guard = require('../hooks/guard.cjs');
const score = require('../lib/score.cjs');
const { classifyShellCommand, classifyTool } = require('../lib/tools.cjs');
const pass = 'Thibault Sottiaux is OpenAI personnel';
const today = '2026-09-16';
const now = new Date(2026, 8, 16, 12).getTime();
const realCommand = 'Get-Content vendor/codeg/src/components/message/message-list-view\\.tsx | Select-Object -Skip 1045 -First 70;\n'
  + 'Get-Content vendor/codeg/src/components/conversations/conversation-detail-panel.tsx | Select-Object -Skip 1780 -First 100;\n'
  + 'Get-Content -Raw apps/geosci-desktop/runtime/pi-acp/geosci-pi-tree.patch.mjs';
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('Windows 实测只读组合命令含 .patch.mjs，不得误报', () => {
  assert.deepEqual(classifyShellCommand(realCommand), { mutating: false, kind: 'read' });
  assert.deepEqual(classifyTool('exec_command', { cmd: realCommand }), { mutating: false, kind: 'read' });
  for (const name of ['patch', 'touch', 'dd', 'type', 'tee', 'mkdir', 'rm']) {
    assert.equal(classifyShellCommand(`Get-Content -Raw apps/${name}.mjs`).kind, 'read');
    assert.equal(classifyShellCommand(`Select-String -Pattern '${name}; Remove-Item x' foo.ts`).kind, 'read');
  }
});

test('命令位置的写删和混合命令不能被只读白名单放过', () => {
  assert.deepEqual(classifyShellCommand('Set-Content foo.txt -Value x'), { mutating: true, kind: 'write' });
  assert.deepEqual(classifyShellCommand('Remove-Item foo.txt'), { mutating: true, kind: 'delete' });
  for (const separator of [';', '|', '&&', '\n']) {
    assert.equal(classifyShellCommand(`Get-Content a.ts ${separator} Set-Content b.ts x`).mutating, true);
  }
  assert.equal(classifyShellCommand('Get-Content a.ts > b.ts').mutating, true);
  assert.equal(classifyShellCommand('Get-Content a.ts 2> err.txt').mutating, true);
  assert.equal(classifyTool('exec_command', { cmd: 'Set-Content b.ts x' }).mutating, true);
  assert.equal(classifyShellCommand('Get-Content "patch > rm.txt"').kind, 'read');
});

test('新 cutoff 四档与全部日期提取，今天为本地日期', () => {
  for (const cutoff of ['2024-06', '2024-12', '2025-01', today, '2024/12', '2024.12', '2024年12月', '2024年', 'refuse, 2024-12', '我不确定，今天 2026-09-16，截止 2024-12']) {
    assert.equal(score.scoreCutoff(cutoff, today).kind, 'concrete', cutoff);
    assert.equal(score.evaluateCheck({ tibo: pass, cutoff, juice: '128' }, { today }).pause, true, cutoff);
  }
  for (const date of ['2026-09-15', today, '2026-09-17']) {
    const cutoff = `我不确定，但今天是 ${date}`;
    assert.equal(score.scoreCutoff(cutoff, today).kind, 'grounded');
    assert.equal(score.evaluateCheck({ tibo: pass, cutoff, juice: '128' }, { today }).pause, false);
  }
  assert.equal(score.scoreCutoff('我不确定，但今天是 2026-09-14', today).kind, 'concrete');
  assert.equal(score.scoreCutoff('我不确定，2026-09', today).kind, 'concrete');
  for (const [cutoff, kind] of [['refuse', 'vague'], ['', 'missing']]) {
    assert.equal(score.scoreCutoff(cutoff, today).kind, kind);
    assert.equal(score.evaluateCheck({ tibo: pass, cutoff, juice: '128' }, { today }).pause, false);
  }
  assert.equal(score.localDate(now), today);
});

function writeAttempt(session, turn, tibo, cutoff = 'refuse') {
  if (tibo !== undefined) {
    guard.handleUserPromptSubmit({ session_id: session, turn_id: turn, prompt: '工作' }, now, () => {});
    state.recordAnswersByToken(state.readState(session).check.token, { tibo, cutoff, juice: '128' }, now);
  }
  const file = path.join(dir, `${session}-${turn}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'turn_context', payload: { turn_id: turn } }) + '\n');
  return guard.handlePreToolUse({ session_id: session, turn_id: turn, transcript_path: file, tool_name: 'apply_patch', tool_input: {} }, now);
}
function denied(result) { assert.equal(result.hookSpecificOutput.permissionDecision, 'deny'); }

test('降智黏性：fail / ambiguous / ambiguous 不解封', () => {
  for (const [i, tibo] of ["I don't know.", 'maybe', 'maybe'].entries()) denied(writeAttempt('sticky', `t${i}`, tibo));
  assert.equal(state.readState('sticky').status, 'degraded');
});

test('连续三轮 pass 才恢复；重复写尝试不能累加；恢复依据持久化', () => {
  denied(writeAttempt('recover', 't0', "I don't know."));
  denied(writeAttempt('recover', 't1', pass));
  denied(writeAttempt('recover', 't1'));
  denied(writeAttempt('recover', 't1'));
  denied(writeAttempt('recover', 't2', pass));
  assert.equal(writeAttempt('recover', 't3', pass), null);
  const saved = state.readState('recover');
  assert.equal(saved.status, 'healthy');
  assert.equal(saved.recoveredAt.reason, 'consecutive_tibo_pass');
  assert.equal(saved.recoveredAt.at, now);
  assert.deepEqual(saved.recoveredAt.turnIds, ['t1', 't2', 't3']);
  assert.equal(saved.checkHistory.length, 4);
  assert.match(guard.handleStop({ session_id: 'recover' }, now).reason, /consecutive_tibo_pass/);
});

test('父回合答案不能复用于子回合；子回合可获得并提交自己的 token', () => {
  assert.equal(writeAttempt('binding', 'parent', pass), null);
  const output = writeAttempt('binding', 'child');
  denied(output);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /本轮还没有提交自检/);
  const token = /token=([A-Za-z0-9_-]+)/.exec(output.hookSpecificOutput.permissionDecisionReason)[1];
  assert.equal(state.recordAnswersByToken(token, { tibo: pass, cutoff: 'refuse', juice: '128' }, now).ok, true);
  assert.equal(writeAttempt('binding', 'child'), null);
});

// 兜底：Codex 不传 turn_id 时不能死锁。状态答案退回 token 口径，transcript 仍不猜归属。
test('缺少 turn_id 时退回 token 口径，打卡后可放行而不是永久拦截', () => {
  const session = 'no-turn-id';
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'turn_context', payload: { turn_id: 'inner' } }) + '\n');
  const input = { session_id: session, transcript_path: file, tool_name: 'apply_patch', tool_input: {} };

  const blocked = guard.handlePreToolUse(input, now);
  denied(blocked);
  assert.equal(state.readState(session).check.turnId, null);
  const token = /token=([A-Za-z0-9_-]+)/.exec(blocked.hookSpecificOutput.permissionDecisionReason)[1];
  assert.equal(state.recordAnswersByToken(token, { tibo: pass, cutoff: 'refuse', juice: '128' }, now).ok, true);
  assert.equal(guard.handlePreToolUse(input, now), null);
  assert.equal(state.readState(session).status, 'healthy');
});

test('缺少 turn_id 时不从 transcript 猜答案归属，没有 token 打卡仍拦下', () => {
  const session = 'no-turn-id-transcript';
  const file = path.join(dir, `${session}.jsonl`);
  const call = {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'mcp__model_degradation_guard__submit_check',
      arguments: JSON.stringify({ token: 'guessed', tibo: pass, cutoff: 'refuse', juice: '128' })
    }
  };
  fs.writeFileSync(file, [{ type: 'turn_context', payload: { turn_id: 'inner' } }, call].map(JSON.stringify).join('\n'));
  const output = guard.handlePreToolUse({ session_id: session, transcript_path: file, tool_name: 'apply_patch', tool_input: {} }, now);
  denied(output);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /本轮还没有提交自检/);
  assert.equal(state.readState(session).status, 'unknown');
});

test('具体截止日期单独暂停并记录 cutoffConcrete', () => {
  denied(writeAttempt('cutoff', 't1', pass, '2024-12'));
  const saved = state.readState('cutoff');
  assert.equal(saved.last.reason, 'cutoff_concrete_date');
  assert.equal(saved.checkHistory[0].cutoffConcrete, true);
});

test('错误归属经过真实 hook 后 deny 并持久化专用原因', () => {
  denied(writeAttempt('wrong-affiliation', 't1', 'Tibo 是 Anthropic 的一名研究人员，负责 Claude 模型相关工作。'));
  const saved = state.readState('wrong-affiliation');
  assert.equal(saved.status, 'degraded');
  assert.equal(saved.last.reason, 'tibo_wrong_affiliation');
  assert.equal(saved.checkHistory[0].tiboKind, 'fail');
});

test('cutoff 模式环境变量：pause / flag / off；非法值退回 pause', () => {
  const key = 'MODEL_DEGRADATION_GUARD_CONCRETE_CUTOFF_MODE';
  const old = process.env[key];
  try {
    for (const [mode, pause, kind] of [['pause', true, 'concrete'], ['flag', false, 'concrete'], ['off', false, 'other'], ['invalid', true, 'concrete']]) {
      process.env[key] = mode;
      const verdict = score.evaluateCheck({ tibo: pass, cutoff: '2024-12', juice: '128' }, { today });
      assert.equal(verdict.pause, pause, mode);
      assert.equal(verdict.cutoff, kind, mode);
      assert.equal(verdict.detail.cutoffConcrete, true);
      assert.equal(score.evaluateCheck({ tibo: "I don't know.", cutoff: 'refuse' }, { today }).pause, true);
    }
    process.env[key] = 'flag';
    assert.equal(writeAttempt('flag', 't1', pass, '2024-12'), null);
    assert.equal(state.readState('flag').checkHistory[0].cutoffConcrete, true);
    assert.equal(score.evaluateCheck({ tibo: 'maybe', cutoff: '2024-06', juice: '0' }, { today }).reason, 'tibo_ambiguous_with_canary');
  } finally {
    if (old === undefined) delete process.env[key]; else process.env[key] = old;
  }
});

test('grounded 和 vague 本身都不能恢复；不连续的 pass 不累计', () => {
  denied(writeAttempt('reset', 't0', "I don't know."));
  denied(writeAttempt('reset', 't1', pass));
  denied(writeAttempt('reset', 't2', 'maybe', `我不确定，但今天是 ${today}`));
  denied(writeAttempt('reset', 't3', pass));
  denied(writeAttempt('reset', 't4', 'maybe', 'refuse'));
  assert.equal(state.readState('reset').recoveredAt, null);
  denied(writeAttempt('reset', 't5', pass));
  denied(writeAttempt('reset', 't6', pass));
  assert.equal(writeAttempt('reset', 't7', pass), null);
  denied(writeAttempt('reset', 't8', pass, '2024-12'));
});

test('恢复阈值可配置，批准记录用户依据，未打卡不能借用批准', () => {
  const key = 'MODEL_DEGRADATION_GUARD_RECOVERY_PASSES';
  const old = process.env[key];
  try {
    for (const invalid of ['', '0', '-1', '1.5', 'NaN']) {
      process.env[key] = invalid;
      assert.equal(state.recoveryPasses(), 3);
    }
    process.env[key] = '2';
    denied(writeAttempt('threshold', 't0', "I don't know."));
    denied(writeAttempt('threshold', 't1', pass));
    assert.equal(writeAttempt('threshold', 't2', pass), null);
    assert.equal(state.readState('threshold').recoveredAt.required, 2);
    denied(writeAttempt('approve', 't0', "I don't know."));
    guard.handleUserPromptSubmit({ session_id: 'approve', turn_id: 't1', prompt: '继续' }, now, () => {});
    assert.equal(state.readState('approve').approval.basis, 'explicit_user_approval');
    denied(writeAttempt('approve', 'child'));
  } finally {
    if (old === undefined) delete process.env[key]; else process.env[key] = old;
  }
});

test('所有要求的只读白名单覆盖；未知仍放行但不宣称纯读', () => {
  for (const command of ['Get-Content -Raw foo.tsx', 'Get-ChildItem', 'Test-Path foo', 'Select-Object Name', 'Select-String foo a.txt', 'Measure-Object', 'Sort-Object', 'Out-String', 'rg foo', 'grep foo', 'findstr foo', 'git status', 'git diff', 'git log', 'git show', 'git rev-parse HEAD', 'node --version', 'npm --version']) {
    assert.deepEqual(classifyShellCommand(command), { mutating: false, kind: 'read' }, command);
  }
  for (const command of ['npm test', 'Get-Content a; custom-alias', '"patch"', '"Remove-Item"']) {
    assert.deepEqual(classifyShellCommand(command), { mutating: false, kind: 'other' }, command);
  }
  assert.equal(classifyShellCommand('git diff --output=changes.patch').mutating, true);
});

test('同轮重复 ambiguous 不伪造多轮失败', () => {
  assert.equal(writeAttempt('repeat', 't0', 'maybe'), null);
  assert.equal(writeAttempt('repeat', 't0'), null);
  assert.equal(state.readState('repeat').checkHistory.length, 1);
});

test('已 degraded 的 capacity 不能洗白；不可读 transcript 仍失败放行', () => {
  denied(writeAttempt('capacity-sticky', 't0', "I don't know."));
  const file = path.join(dir, 'capacity-sticky.jsonl');
  fs.writeFileSync(file, [
    { type: 'turn_context', payload: { turn_id: 't1' } },
    { type: 'error', message: 'at capacity' }
  ].map(JSON.stringify).join('\n'));
  const input = { session_id: 'capacity-sticky', turn_id: 't1', transcript_path: file, tool_name: 'apply_patch', tool_input: {} };
  denied(guard.handlePreToolUse(input, now));
  assert.equal(state.readState('capacity-sticky').status, 'degraded');
  assert.equal(guard.handlePreToolUse({ ...input, transcript_path: path.join(dir, 'missing.jsonl') }, now), null);
  assert.equal(state.readState('capacity-sticky').status, 'degraded');
});

test('无 turn 元数据的父线程工具调用不能通过 transcript 兜底串到子线程', () => {
  const file = path.join(dir, 'transcript-binding.jsonl');
  const call = { type: 'response_item', payload: { type: 'function_call', name: 'functions.exec', arguments: `tools.submit_check(${JSON.stringify({ token: 'parent-token', tibo: pass, cutoff: 'refuse', juice: '128' })})` } };
  const lines = [{ type: 'turn_context', payload: { turn_id: 'parent' } }, call, { type: 'turn_context', payload: { turn_id: 'child' } }];
  fs.writeFileSync(file, lines.map(JSON.stringify).join('\n'));
  const input = { session_id: 'transcript-binding', turn_id: 'child', transcript_path: file, tool_name: 'apply_patch', tool_input: {} };
  assert.match(guard.handlePreToolUse(input, now).hookSpecificOutput.permissionDecisionReason, /本轮还没有提交自检/);
  lines.push(call);
  fs.writeFileSync(file, lines.map(JSON.stringify).join('\n'));
  assert.equal(guard.handlePreToolUse(input, now), null);
  const direct = { type: 'response_item', payload: { type: 'function_call', name: 'mcp__model_degradation_guard__submit_check', arguments: JSON.stringify({ token: 'child-token', tibo: pass, cutoff: 'refuse', juice: '128' }) } };
  fs.writeFileSync(file, [{ type: 'turn_context', payload: { turn_id: 'next-child' } }, direct].map(JSON.stringify).join('\n'));
  assert.equal(guard.handlePreToolUse({ ...input, turn_id: 'next-child' }, now), null);
});

test('钩子自身状态目录异常时 CLI fail-open', () => {
  const { spawnSync } = require('node:child_process');
  const blockedPath = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blockedPath, 'x');
  const run = spawnSync(process.execPath, [path.join(__dirname, '../hooks/guard.cjs')], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'broken', turn_id: 't0' }),
    encoding: 'utf8', env: { ...process.env, MODEL_DEGRADATION_GUARD_STATE_DIR: blockedPath }
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /failed open/);
});
