'use strict';

// 会话级状态：~/.codex/model-degradation-guard/<session_id>.json
//
// 状态机（docs/design.md）：
//   unknown / healthy      —— 写前仍要本轮打卡
//   degraded              —— 写/删暂停并询问
//   degraded_approved     —— 本会话写/删放行，每轮仍打卡
//   overloaded            —— 只提示过载，不当降智
//
// 批准只绑当前 session_id，不跨会话、不硬封。

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 状态目录：默认 ~/.codex/model-degradation-guard；若用户用 CODEX_HOME 指定了 home，
// 则跟着走，保证钩子与探针（含隔离 home）落在同一个位置。
const CODEX_HOME = process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
  ? process.env.CODEX_HOME.trim()
  : path.join(os.homedir(), '.codex');

const STATE_DIR = process.env.MODEL_DEGRADATION_GUARD_STATE_DIR
  || path.join(CODEX_HOME, 'model-degradation-guard');

const STATE_VERSION = 1;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const STATUSES = new Set(['unknown', 'healthy', 'degraded', 'degraded_approved', 'overloaded']);

// 用户批准只认「回复开头就是确认词」，避免「不要继续」这类被误判。
const APPROVAL_PATTERN = /^\s*[「『"'*>*\s]*(?:继续|放行|批准|确认|同意|可以继续|approve|approved|continue|proceed|allow|go\s+ahead|yes)/i;

function safeSessionId(sessionId) {
  const raw = String(sessionId == null ? '' : sessionId).trim();
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error('session_id is required to store guard state.');
  }
  return cleaned;
}

function statePath(sessionId) {
  return path.join(STATE_DIR, `${safeSessionId(sessionId)}.json`);
}

function defaultState(sessionId, now = Date.now()) {
  return {
    version: STATE_VERSION,
    sessionId: safeSessionId(sessionId),
    status: 'unknown',
    usedDegraded: false,
    firstDegradedAt: null,
    wroteDegradedAt: null,
    degradedWriteTurns: 0,
    lastWriteTurnId: null,
    warnedAt: null,
    warnedWriteTurns: 0,
    check: null,
    answers: null,
    last: null,
    approval: null,
    lastPausedTurnId: null,
    updatedAt: now
  };
}

function normalizeState(value, sessionId, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultState(sessionId, now);
  if (value.version !== STATE_VERSION) return defaultState(sessionId, now);
  const state = defaultState(sessionId, now);
  if (STATUSES.has(value.status)) state.status = value.status;
  state.usedDegraded = value.usedDegraded === true;
  state.firstDegradedAt = typeof value.firstDegradedAt === 'number' ? value.firstDegradedAt : null;
  state.wroteDegradedAt = typeof value.wroteDegradedAt === 'number' ? value.wroteDegradedAt : null;
  state.degradedWriteTurns = Number.isInteger(value.degradedWriteTurns) ? value.degradedWriteTurns : 0;
  state.lastWriteTurnId = typeof value.lastWriteTurnId === 'string' ? value.lastWriteTurnId : null;
  state.warnedAt = typeof value.warnedAt === 'number' ? value.warnedAt : null;
  state.warnedWriteTurns = Number.isInteger(value.warnedWriteTurns) ? value.warnedWriteTurns : 0;
  state.check = value.check && typeof value.check === 'object' ? value.check : null;
  state.answers = value.answers && typeof value.answers === 'object' ? value.answers : null;
  state.last = value.last && typeof value.last === 'object' ? value.last : null;
  state.approval = value.approval && typeof value.approval === 'object' ? value.approval : null;
  state.lastPausedTurnId = typeof value.lastPausedTurnId === 'string' ? value.lastPausedTurnId : null;
  if (typeof value.updatedAt === 'number') state.updatedAt = value.updatedAt;
  return state;
}

function readState(sessionId, now = Date.now()) {
  try {
    const raw = fs.readFileSync(statePath(sessionId), 'utf8');
    return normalizeState(JSON.parse(raw), sessionId, now);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.name === 'SyntaxError')) return defaultState(sessionId, now);
    throw error;
  }
}

function writeState(state, now = Date.now()) {
  const target = statePath(state.sessionId);
  const updated = { ...state, version: STATE_VERSION, updatedAt: now };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(updated)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
  return updated;
}

function pruneStates(now = Date.now()) {
  let entries;
  try {
    entries = fs.readdirSync(STATE_DIR, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/^[A-Za-z0-9._-]+\.json$/.test(entry.name)) continue;
    if (entry.name === 'update.json') continue;
    const filePath = path.join(STATE_DIR, entry.name);
    try {
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > STATE_TTL_MS) {
        fs.unlinkSync(filePath);
        removed += 1;
      }
    } catch {
      // 清理失败不影响主流程。
    }
  }
  return removed;
}

function recordCheck(state, { turnId, verdict }, now = Date.now()) {
  state.last = {
    turnId: turnId || null,
    tibo: verdict.tibo,
    cutoff: verdict.cutoff,
    juice: verdict.juice,
    pause: verdict.pause === true,
    reason: verdict.reason || null,
    at: now
  };
  if (verdict.pause) {
    state.usedDegraded = true;
    if (!state.firstDegradedAt) state.firstDegradedAt = now;
  }
  return state;
}

function approveSession(state, now = Date.now()) {
  state.status = 'degraded_approved';
  state.usedDegraded = true;
  if (!state.firstDegradedAt) state.firstDegradedAt = now;
  state.approval = {
    reason: state.last && state.last.reason ? state.last.reason : null,
    turnId: state.last && state.last.turnId ? state.last.turnId : null,
    at: now
  };
  return state;
}

function isApprovalPrompt(prompt) {
  return APPROVAL_PATTERN.test(String(prompt == null ? '' : prompt));
}

// ── 每轮自检令牌 ────────────────────────────────────────────────
// 模型通过 MCP 工具 submit_check 提交三字段，MCP 进程不知道 session_id，所以用
// 「每轮刷新的一次性 token」回绑会话：UserPromptSubmit 发 token，工具按 token 找状态。

const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

function startCheck(state, { turnId, token }, now = Date.now()) {
  state.check = { token: String(token), turnId: turnId || null, createdAt: now };
  state.answers = null;
  return state;
}

function findStateByToken(token, now = Date.now()) {
  if (typeof token !== 'string' || !token) return null;
  let entries;
  try {
    entries = fs.readdirSync(STATE_DIR, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^[A-Za-z0-9._-]+\.json$/.test(entry.name)) continue;
    if (entry.name === 'update.json') continue;
    const filePath = path.join(STATE_DIR, entry.name);
    let state;
    try {
      state = normalizeState(JSON.parse(fs.readFileSync(filePath, 'utf8')), entry.name.replace(/\.json$/, ''), now);
    } catch {
      continue;
    }
    if (!state.check || state.check.token !== token) continue;
    if (typeof state.check.createdAt === 'number' && now - state.check.createdAt > CHECK_TTL_MS) continue;
    return state;
  }
  return null;
}

// MCP 工具 submit_check 的写入入口：只记录，不下判定（判定只在 hooks/guard.cjs）。
function recordAnswersByToken(token, fields, now = Date.now()) {
  const state = findStateByToken(token, now);
  if (!state) return { ok: false, error: 'token 无效或已过期；请使用本轮提示里的 token。' };
  state.answers = {
    token: String(token),
    turnId: state.check ? state.check.turnId : null,
    tibo: String(fields && fields.tibo != null ? fields.tibo : ''),
    cutoff: String(fields && fields.cutoff != null ? fields.cutoff : ''),
    juice: String(fields && fields.juice != null ? fields.juice : ''),
    at: now
  };
  writeState(state, now);
  return { ok: true, sessionId: state.sessionId };
}

// 本轮是否已经拿到答案（token 与当前轮一致）。
function answersForCurrentCheck(state) {
  if (!state || !state.check || !state.answers) return null;
  return state.answers.token === state.check.token ? state.answers : null;
}

module.exports = {
  APPROVAL_PATTERN,
  CHECK_TTL_MS,
  CODEX_HOME,
  STATE_DIR,
  STATE_TTL_MS,
  STATE_VERSION,
  answersForCurrentCheck,
  approveSession,
  defaultState,
  findStateByToken,
  isApprovalPrompt,
  pruneStates,
  readState,
  recordAnswersByToken,
  recordCheck,
  safeSessionId,
  startCheck,
  statePath,
  writeState
};
