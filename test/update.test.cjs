'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdg-update-'));
process.env.MODEL_DEGRADATION_GUARD_STATE_DIR = stateDir;
delete process.env.MODEL_DEGRADATION_GUARD_UPDATE_CHECK;
process.env.MODEL_DEGRADATION_GUARD_LOCAL_VERSION = '0.1.7';

const update = require('../lib/update.cjs');
const guard = require('../hooks/guard.cjs');
const state = require('../lib/state.cjs');

test.after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('版本比较：只有三段数字且远程更大才算新', () => {
  assert.equal(update.compareVersions('0.1.8', '0.1.7'), 1);
  assert.equal(update.compareVersions('0.1.7', '0.1.7'), 0);
  assert.equal(update.compareVersions('0.1.6', '0.1.7'), -1);
  assert.equal(update.isNewer('0.1.8', '0.1.7'), true);
  assert.equal(update.isNewer('0.1.7', '0.1.7'), false);
  assert.equal(update.isNewer('oops', '0.1.7'), false);
});

test('每个远程版本只通知一次；没跑满提醒间隔不走 Stop', () => {
  const record = {
    lastNotifiedVersion: null,
    lastNotifiedAt: 0,
    lastStopRemindedVersion: null
  };
  assert.equal(update.shouldNotify(record, '0.1.7', '0.1.8'), true);
  assert.equal(update.shouldNotify({ ...record, lastNotifiedVersion: '0.1.8' }, '0.1.7', '0.1.8'), false);
  assert.equal(update.shouldNotify({ ...record, lastNotifiedVersion: '0.1.8' }, '0.1.7', '0.1.9'), true);
  assert.equal(update.shouldNotify(record, '0.1.8', '0.1.8'), false);

  const now = 1_000_000;
  assert.equal(update.shouldStopRemind({
    lastNotifiedVersion: '0.1.8',
    lastNotifiedAt: now,
    lastStopRemindedVersion: null
  }, '0.1.7', '0.1.8', now + 1000, 5000), false);
  assert.equal(update.shouldStopRemind({
    lastNotifiedVersion: '0.1.8',
    lastNotifiedAt: now,
    lastStopRemindedVersion: null
  }, '0.1.7', '0.1.8', now + 6000, 5000), true);
  assert.equal(update.shouldStopRemind({
    lastNotifiedVersion: '0.1.8',
    lastNotifiedAt: now,
    lastStopRemindedVersion: '0.1.8'
  }, '0.1.7', '0.1.8', now + 6000, 5000), false);
});

test('UPDATE_CHECK=0 时不检查也不通知', () => {
  process.env.MODEL_DEGRADATION_GUARD_UPDATE_CHECK = '0';
  try {
    assert.equal(update.isEnabled(), false);
    assert.equal(update.maybeKickCheck(Date.now(), () => { throw new Error('should not spawn'); }), false);
    assert.equal(update.takePromptNotice(Date.now()), '');
  } finally {
    delete process.env.MODEL_DEGRADATION_GUARD_UPDATE_CHECK;
  }
});

test('UserPromptSubmit 发现新版本时注入转述，同一版本第二次不再注入', () => {
  const now = Date.now();
  update.saveRecord({
    lastCheckAt: now,
    latestRemote: '0.1.8',
    lastNotifiedVersion: null,
    lastNotifiedAt: 0,
    lastStopRemindedVersion: null
  });
  const first = guard.handleUserPromptSubmit({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'upd-1',
    turn_id: 't1',
    prompt: '干活'
  }, now);
  const context = first.hookSpecificOutput.additionalContext;
  assert.match(context, /0\.1\.8/);
  assert.match(context, /marketplace upgrade/);
  assert.match(context, /submit_check/);

  const second = guard.handleUserPromptSubmit({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'upd-1',
    turn_id: 't2',
    prompt: '继续干活'
  }, now + 1);
  assert.doesNotMatch(second.hookSpecificOutput.additionalContext, /【插件更新】/);
});

test('Stop：降智提醒优先；否则隔几天补一句更新', () => {
  const now = Date.now();
  update.saveRecord({
    lastCheckAt: now,
    latestRemote: '0.1.8',
    lastNotifiedVersion: '0.1.8',
    lastNotifiedAt: now - 4 * 24 * 60 * 60 * 1000,
    lastStopRemindedVersion: null
  });

  const current = state.defaultState('upd-stop', now);
  current.usedDegraded = true;
  current.degradedWriteTurns = 1;
  current.firstDegradedAt = now;
  state.writeState(current, now);
  const degraded = guard.handleStop({
    hook_event_name: 'Stop',
    session_id: 'upd-stop',
    stop_hook_active: false
  }, now);
  assert.equal(degraded.decision, 'block');
  assert.match(degraded.reason, /降智/);

  const healthy = guard.handleStop({
    hook_event_name: 'Stop',
    session_id: 'upd-healthy',
    stop_hook_active: false
  }, now);
  assert.equal(healthy.decision, 'block');
  assert.match(healthy.reason, /0\.1\.8/);
  assert.doesNotMatch(healthy.reason, /降智/);

  const again = guard.handleStop({
    hook_event_name: 'Stop',
    session_id: 'upd-healthy',
    stop_hook_active: false
  }, now + 1);
  assert.equal(again, null);
});

test('后台检查失败保持静默，不改已有远程版本', async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 500;
    res.end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  process.env.MODEL_DEGRADATION_GUARD_UPDATE_URL = `http://127.0.0.1:${port}/plugin.json`;
  update.saveRecord({
    lastCheckAt: 1,
    latestRemote: '0.1.8',
    lastNotifiedVersion: null,
    lastNotifiedAt: 0,
    lastStopRemindedVersion: null
  });
  try {
    const got = await update.runFetch(50);
    assert.equal(got, null);
    assert.equal(update.loadRecord().latestRemote, '0.1.8');
  } finally {
    delete process.env.MODEL_DEGRADATION_GUARD_UPDATE_URL;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('检查间隔内不重复拉起进程', () => {
  const now = Date.now();
  update.saveRecord({
    lastCheckAt: now,
    latestRemote: '0.1.8',
    lastNotifiedVersion: null,
    lastNotifiedAt: 0,
    lastStopRemindedVersion: null
  });
  const kicked = update.maybeKickCheck(now + 1000, () => {
    throw new Error('should not spawn');
  });
  assert.equal(kicked, false);
});

test('过期清理不会删掉 update.json', () => {
  update.saveRecord({
    lastCheckAt: 1,
    latestRemote: '0.1.8',
    lastNotifiedVersion: '0.1.8',
    lastNotifiedAt: 1,
    lastStopRemindedVersion: null
  });
  const past = fs.statSync(update.updatePath()).mtimeMs;
  const old = new Date(past - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(update.updatePath(), old, old);
  state.pruneStates(Date.now());
  assert.equal(fs.existsSync(update.updatePath()), true);
});
