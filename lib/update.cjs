'use strict';

// 版本通知：每个用户回合检查 GitHub 上的 plugin.json，本地落后时持续让模型转述给用户。
// 不自动安装。失败放行。不进写前闸门热路径。

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const path = require('node:path');

const state = require('./state.cjs');

const DEFAULT_URL = 'https://raw.githubusercontent.com/Awfp1314/codex-degrade-guard/master/.codex-plugin/plugin.json';
const UPGRADE_CMD = 'codex plugin marketplace upgrade model-degradation-guard';
const ADD_CMD = 'codex plugin add model-degradation-guard@model-degradation-guard';

function isEnabled() {
  return String(process.env.MODEL_DEGRADATION_GUARD_UPDATE_CHECK || '') !== '0';
}

function remindAfterMs() {
  const raw = process.env.MODEL_DEGRADATION_GUARD_UPDATE_REMIND_MS;
  if (raw === undefined || raw === '') return 3 * 24 * 60 * 60 * 1000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 3 * 24 * 60 * 60 * 1000;
}

function remoteUrl() {
  if (process.env.MODEL_DEGRADATION_GUARD_UPDATE_URL) {
    return process.env.MODEL_DEGRADATION_GUARD_UPDATE_URL;
  }
  return `${DEFAULT_URL}?t=${Date.now()}`;
}

function updatePath() {
  return path.join(state.STATE_DIR, 'update.json');
}

function emptyRecord() {
  return {
    lastCheckAt: 0,
    latestRemote: null,
    lastNotifiedVersion: null,
    lastNotifiedAt: 0,
    lastStopRemindedVersion: null
  };
}

function loadRecord() {
  try {
    const raw = JSON.parse(fs.readFileSync(updatePath(), 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyRecord();
    return {
      lastCheckAt: typeof raw.lastCheckAt === 'number' ? raw.lastCheckAt : 0,
      latestRemote: typeof raw.latestRemote === 'string' ? raw.latestRemote : null,
      lastNotifiedVersion: typeof raw.lastNotifiedVersion === 'string' ? raw.lastNotifiedVersion : null,
      lastNotifiedAt: typeof raw.lastNotifiedAt === 'number' ? raw.lastNotifiedAt : 0,
      lastStopRemindedVersion: typeof raw.lastStopRemindedVersion === 'string' ? raw.lastStopRemindedVersion : null
    };
  } catch {
    return emptyRecord();
  }
}

function saveRecord(record) {
  fs.mkdirSync(state.STATE_DIR, { recursive: true });
  const temporary = `${updatePath()}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, updatePath());
  return record;
}

function parseVersion(value) {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function isNewer(remote, local) {
  return compareVersions(remote, local) > 0;
}

function localVersion() {
  if (process.env.MODEL_DEGRADATION_GUARD_LOCAL_VERSION) {
    return String(process.env.MODEL_DEGRADATION_GUARD_LOCAL_VERSION);
  }
  try {
    const file = path.join(__dirname, '..', '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '';
  } catch {
    return '';
  }
}

function shouldNotify(_record, local, remote) {
  if (!remote || !local) return false;
  return isNewer(remote, local);
}

function shouldStopRemind(record, local, remote, now, delayMs = remindAfterMs()) {
  if (!remote || !local) return false;
  if (!isNewer(remote, local)) return false;
  if (record.lastNotifiedVersion !== remote) return false;
  if (record.lastStopRemindedVersion === remote) return false;
  if (!record.lastNotifiedAt) return false;
  return now - record.lastNotifiedAt >= delayMs;
}

function promptNotice(local, remote) {
  return [
    '【插件更新】用一两句话告诉用户后继续原任务，不要展开、不要替用户执行更新：',
    `Model Degradation Guard 有新版本 ${remote}（当前 ${local}）。`,
    `请结束对话后运行：${UPGRADE_CMD} 然后 ${ADD_CMD}。`,
    '新开对话，到设置 → 钩子把本插件三条重新点信任。不点则闸门停。'
  ].join('');
}

function stopNotice(local, remote) {
  return [
    '【插件更新】只做一件事：把下面这句话原样转达给用户，不要额外干活，不要改代码：',
    `「Model Degradation Guard 有新版本 ${remote}（当前 ${local}）。请运行 ${UPGRADE_CMD} 然后 ${ADD_CMD}，新开对话并重新信任钩子。」`
  ].join('');
}

function ensureFresh(now = Date.now(), spawnSyncImpl = spawnSync) {
  if (!isEnabled()) return false;
  const record = loadRecord();
  saveRecord({ ...record, lastCheckAt: now });
  try {
    spawnSyncImpl(process.execPath, [__filename, '--fetch'], {
      timeout: 3500,
      env: process.env,
      windowsHide: true,
      encoding: 'utf8'
    });
  } catch {
    // 超时或拉起失败：本轮用已有缓存。
  }
  return true;
}

function takePromptNotice(now = Date.now()) {
  if (!isEnabled()) return '';
  const record = loadRecord();
  const local = localVersion();
  const remote = record.latestRemote;
  if (!shouldNotify(record, local, remote)) return '';
  saveRecord({ ...record, lastNotifiedVersion: remote, lastNotifiedAt: now });
  return promptNotice(local, remote);
}

function takeStopNotice(now = Date.now(), stopHookActive = false) {
  if (!isEnabled()) return '';
  if (stopHookActive) return '';
  const record = loadRecord();
  const local = localVersion();
  const remote = record.latestRemote;
  if (!shouldStopRemind(record, local, remote, now)) return '';
  saveRecord({ ...record, lastStopRemindedVersion: remote });
  return stopNotice(local, remote);
}

function fetchRemoteVersion(url = remoteUrl(), transport) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve(null);
      return;
    }
    const lib = transport || (parsed.protocol === 'http:' ? http : https);
    const req = lib.get(parsed, {
      headers: { 'User-Agent': 'model-degradation-guard', Accept: 'application/json' },
      timeout: 3000
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 20000) {
          req.destroy();
          resolve(null);
        }
      });
      res.on('end', () => {
        try {
          const version = JSON.parse(body).version;
          resolve(typeof version === 'string' && parseVersion(version) ? version : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

async function runFetch(now = Date.now()) {
  const version = await fetchRemoteVersion();
  const record = loadRecord();
  record.lastCheckAt = now;
  if (version) record.latestRemote = version;
  saveRecord(record);
  return version;
}

if (require.main === module && process.argv.includes('--fetch')) {
  runFetch().catch(() => {
    // 后台检查失败静默。
  });
}

module.exports = {
  ADD_CMD,
  DEFAULT_URL,
  UPGRADE_CMD,
  compareVersions,
  fetchRemoteVersion,
  isEnabled,
  isNewer,
  loadRecord,
  localVersion,
  ensureFresh,
  promptNotice,
  remindAfterMs,
  runFetch,
  saveRecord,
  shouldNotify,
  shouldStopRemind,
  stopNotice,
  takePromptNotice,
  takeStopNotice,
  updatePath
};
