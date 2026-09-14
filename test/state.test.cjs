'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdg-state-test-'));
process.env.MODEL_DEGRADATION_GUARD_STATE_DIR = stateDir;

const state = require('../lib/state.cjs');

test.after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('默认状态是 unknown，且没写过文件', () => {
  const current = state.readState('session-a');
  assert.equal(current.status, 'unknown');
  assert.equal(current.usedDegraded, false);
  assert.equal(current.last, null);
});

test('写状态是原子的，读回来一致', () => {
  const current = state.readState('session-a');
  current.status = 'healthy';
  state.writeState(current, 1700000000000);
  const reloaded = state.readState('session-a');
  assert.equal(reloaded.status, 'healthy');
  assert.equal(reloaded.updatedAt, 1700000000000);
  assert.equal(fs.existsSync(state.statePath('session-a')), true);
});

test('session_id 会被清洗，不能跳出状态目录', () => {
  const current = state.readState('../../evil/../id');
  state.writeState(current, 1700000000000);
  const files = fs.readdirSync(stateDir).filter((name) => name.endsWith('.json'));
  assert.equal(files.includes('.._.._evil_.._id.json'), true);
  assert.equal(files.includes('id.json'), false);
  assert.throws(() => state.statePath(''), /session_id is required/);
});

test('recordCheck 记录三字段并在暂停时标记 usedDegraded', () => {
  const current = state.readState('session-b');
  state.recordCheck(current, {
    turnId: 'turn-1',
    verdict: { tibo: 'pass', cutoff: 'refuse', juice: 'positive', pause: false, reason: null }
  }, 1700000000000);
  assert.equal(current.usedDegraded, false);
  assert.deepEqual(current.last, {
    turnId: 'turn-1',
    tibo: 'pass',
    cutoff: 'refuse',
    juice: 'positive',
    pause: false,
    reason: null,
    at: 1700000000000
  });

  state.recordCheck(current, {
    turnId: 'turn-2',
    verdict: { tibo: 'fail', cutoff: 'refuse', juice: 'none', pause: true, reason: 'tibo_fail' }
  }, 1700000001000);
  assert.equal(current.usedDegraded, true);
  assert.equal(current.firstDegradedAt, 1700000001000);
  assert.equal(current.last.reason, 'tibo_fail');

  // 首次命中时间不会被后续命中覆盖。
  state.recordCheck(current, {
    turnId: 'turn-3',
    verdict: { tibo: 'fail', cutoff: 'refuse', juice: 'none', pause: true, reason: 'tibo_fail' }
  }, 1700000005000);
  assert.equal(current.firstDegradedAt, 1700000001000);
});

test('approveSession 只放行本会话并记住批准原因', () => {
  const current = state.defaultState('session-b');
  state.recordCheck(current, {
    turnId: 'turn-2',
    verdict: { tibo: 'fail', cutoff: 'refuse', juice: 'none', pause: true, reason: 'tibo_fail' }
  }, 1700000001000);
  state.approveSession(current, 1700000002000);
  assert.equal(current.status, 'degraded_approved');
  assert.equal(current.usedDegraded, true);
  assert.equal(current.approval.reason, 'tibo_fail');
  assert.equal(current.approval.turnId, 'turn-2');
  assert.equal(current.approval.at, 1700000002000);
});

test('批准文案识别：开头是确认词才算，否定与普通提问都不算', () => {
  assert.equal(state.isApprovalPrompt('继续'), true);
  assert.equal(state.isApprovalPrompt('继续实现插件'), true);
  assert.equal(state.isApprovalPrompt('  「放行」'), true);
  assert.equal(state.isApprovalPrompt('approve'), true);
  assert.equal(state.isApprovalPrompt('Continue with the task'), true);
  assert.equal(state.isApprovalPrompt('不要继续'), false);
  assert.equal(state.isApprovalPrompt('先别放行'), false);
  assert.equal(state.isApprovalPrompt('这个函数怎么写'), false);
  assert.equal(state.isApprovalPrompt(''), false);
});

test('损坏或版本不符的状态文件会退回默认状态', () => {
  fs.writeFileSync(path.join(stateDir, 'broken.json'), '{not json', 'utf8');
  assert.equal(state.readState('broken').status, 'unknown');

  fs.writeFileSync(path.join(stateDir, 'oldver.json'), JSON.stringify({ version: 0, status: 'degraded' }), 'utf8');
  assert.equal(state.readState('oldver').status, 'unknown');
});

test('每轮令牌绑定会话：startCheck 发 token，recordAnswersByToken 按 token 回写', () => {
  const current = state.defaultState('session-token');
  state.startCheck(current, { turnId: 'turn-1', token: 'tok-aaa' }, 1700000000000);
  current.status = 'healthy';
  state.writeState(current, 1700000000000);

  const outcome = state.recordAnswersByToken('tok-aaa', {
    tibo: 'Thibault Sottiaux is OpenAI personnel', cutoff: 'refuse', juice: '64'
  }, 1700000001000);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.sessionId, 'session-token');

  const saved = state.readState('session-token');
  assert.equal(saved.answers.token, 'tok-aaa');
  assert.equal(saved.answers.turnId, 'turn-1');
  assert.equal(saved.answers.juice, '64');
});

test('令牌无效或过期时拒绝写入', () => {
  const bad = state.recordAnswersByToken('nope', { tibo: 'x', cutoff: 'refuse', juice: '1' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /token/);
  assert.equal(state.recordAnswersByToken('', { tibo: 'x' }).ok, false);

  const current = state.defaultState('session-expired');
  state.startCheck(current, { turnId: 'turn-1', token: 'tok-old' }, 1700000000000);
  state.writeState(current, 1700000000000);
  const expired = state.recordAnswersByToken('tok-old', { tibo: 'x' }, 1700000000000 + state.CHECK_TTL_MS + 1);
  assert.equal(expired.ok, false);
});

test('answersForCurrentCheck 只认当前轮令牌的答案', () => {
  const current = state.defaultState('session-current');
  state.startCheck(current, { turnId: 'turn-1', token: 'tok-1' }, 1700000000000);
  assert.equal(state.answersForCurrentCheck(current), null);

  current.answers = { token: 'tok-0', tibo: 'stale' };
  assert.equal(state.answersForCurrentCheck(current), null);

  current.answers = { token: 'tok-1', tibo: 'fresh' };
  assert.equal(state.answersForCurrentCheck(current).tibo, 'fresh');

  // 新的一轮刷新 token 后，上一轮答案自动失效。
  state.startCheck(current, { turnId: 'turn-2', token: 'tok-2' }, 1700000000000);
  assert.equal(state.answersForCurrentCheck(current), null);
});

test('startCheck 会清掉上一轮答案', () => {
  const current = state.defaultState('session-reset');
  state.startCheck(current, { turnId: 'turn-1', token: 'tok-1' }, 1700000000000);
  current.answers = { token: 'tok-1', tibo: 'x' };
  state.startCheck(current, { turnId: 'turn-2', token: 'tok-2' }, 1700000001000);
  assert.equal(current.answers, null);
  assert.equal(current.check.turnId, 'turn-2');
});

test('过期状态会被清理，新状态保留', () => {
  const fresh = path.join(stateDir, 'fresh.json');
  const stale = path.join(stateDir, 'stale.json');
  fs.writeFileSync(fresh, '{"version":1}', 'utf8');
  fs.writeFileSync(stale, '{"version":1}', 'utf8');
  const old = Date.now() - state.STATE_TTL_MS - 1000;
  fs.utimesSync(stale, old / 1000, old / 1000);

  state.pruneStates();
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
});
