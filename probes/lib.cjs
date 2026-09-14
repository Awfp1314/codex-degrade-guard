'use strict';

// 手动体检探针的共用部分：都是「另起一个空会话跑 codex exec 拿输出」。
//
// 关键点：
//   - --ephemeral + --disable memories：空会话、不带历史记忆。
//   - MODEL_DEGRADATION_GUARD_DISABLE=1：避免本插件自己的钩子污染探针结果。

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 单次 codex exec 的时间上限：超时按「本次运行失败」处理，不拖死整个探针。
const DEFAULT_RUN_TIMEOUT_MS = Number(process.env.MODEL_DEGRADATION_GUARD_RUN_TIMEOUT_MS) || 5 * 60 * 1000;

function resolveCodexBinary() {
  if (process.env.MODEL_DEGRADATION_GUARD_CODEX_BIN) return process.env.MODEL_DEGRADATION_GUARD_CODEX_BIN;

  // Windows 上 npm 会同时生成 codex、codex.cmd、codex.ps1；
  // .exe 可直接启动，.cmd 必须交给 shell。
  const candidates = process.platform === 'win32'
    ? ['codex.exe', 'codex.cmd', 'codex']
    : ['codex'];
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const file of candidates) {
    for (const dir of dirs) {
      const candidate = path.join(dir, file);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // 继续找。
      }
    }
  }
  throw new Error('找不到 codex 可执行文件，请确认已安装 codex CLI 并加入 PATH。');
}

function makeTempDir(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return root;
}

// 跑一次 codex exec --json，返回事件流与用量。
function buildExecArgs(options = {}) {
  const { model, reasoningEffort, sandbox = 'read-only', extraArgs = [], disableHooks = true } = options;
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '-s', sandbox,
    '--disable', 'memories'
  ];
  // 真空会话：不带用户配置里已装的插件钩子（包括本插件自己）。
  if (disableHooks) args.push('--disable', 'hooks');
  if (model) args.push('-m', model);
  if (reasoningEffort) args.push('-c', `model_reasoning_effort=${reasoningEffort}`);
  args.push(...extraArgs);
  return args;
}

// 老版本 Codex 不认识 hooks 这个特性开关时会直接报错，这时去掉该开关重试。
function shouldRetryWithoutHooks(stderr) {
  return /Unknown feature flag/i.test(String(stderr || ''));
}

// Windows 上 .cmd/.bat 不能直接 spawn（Node 会拒绝），需要交给 shell 并自行引号。
function quoteArg(value) {
  const text = String(value);
  return /[\s"&|<>^()%!]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

// 异步 spawn（而不是 spawnSync）：糖果探针靠它才能做真正的多路并行。
// spawnSync 会阻塞事件循环，两个 worker 实际会退化成串行，5 次就要等 5 倍时间。
function spawnCodexExec(args, options) {
  return new Promise((resolve) => {
    const { cwd, timeoutMs } = options;
    const binary = resolveCodexBinary();
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
    const spawnOptions = {
      cwd: cwd && fs.existsSync(cwd) ? cwd : process.cwd(),
      env: { ...process.env, MODEL_DEGRADATION_GUARD_DISABLE: '1' }
    };

    let child;
    try {
      child = useShell
        // 传单个命令行字符串（而不是 args 数组）可以避开 Node 的 DEP0190 提示，
        // 因为参数已经由 quoteArg 逐个引号处理。
        ? spawn([binary, ...args.map(quoteArg)].join(' '), { ...spawnOptions, shell: true })
        : spawn(binary, args, { ...spawnOptions, shell: false });
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error, timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        try { child.kill(); } catch { /* 已经退出 */ }
        // 给子进程一点时间把 stderr 刷出来，再兜底结束。
        killTimer = setTimeout(() => finish({ status: null, stdout, stderr, error: null, timedOut: true }), 500);
      }, timeoutMs)
      : null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ status: null, stdout, stderr, error, timedOut: false }));
    child.on('close', (status) => finish({ status, stdout, stderr, error: null, timedOut: false }));

    child.stdin.on('error', () => { /* 子进程提前退出时忽略 EPIPE */ });
    child.stdin.end(options.prompt == null ? '' : String(options.prompt));
  });
}

async function runCodexExec(options = {}) {
  const { prompt, cwd, timeoutMs = DEFAULT_RUN_TIMEOUT_MS } = options;

  const started = Date.now();
  let result = await spawnCodexExec(buildExecArgs(options), { prompt, cwd, timeoutMs });

  if (!result.error && !result.timedOut && result.status !== 0 && shouldRetryWithoutHooks(result.stderr)) {
    result = await spawnCodexExec(buildExecArgs({ ...options, disableHooks: false }), { prompt, cwd, timeoutMs });
  }

  // ENOENT 之类的启动失败直接抛；超时/非零退出走 failure 字段，让探针给出可读结论。
  if (result.error) throw result.error;

  const events = [];
  for (const line of String(result.stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // 忽略非 JSON 行。
    }
  }

  return {
    events,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    exitCode: result.status,
    elapsedMs: Date.now() - started,
    timedOut: result.timedOut === true,
    failure: result.timedOut ? `单次运行超时（>${Math.round(timeoutMs / 1000)}s）` : extractFailureText(result)
  };
}

function extractFailureText(result) {
  const stderr = String(result.stderr || '').trim();
  if (stderr) {
    const match = /(Selected model is at capacity[^\n]*|server_is_overloaded[^\n]*|overloaded[^\n]*)/i.exec(stderr);
    if (match) return match[1];
  }
  if (result.status !== 0 && stderr) return stderr.split('\n').slice(-1)[0];
  return '';
}

function agentMessages(events) {
  const messages = [];
  for (const event of events) {
    if (!event || event.type !== 'item.completed') continue;
    const item = event.item;
    if (!item || item.type !== 'agent_message') continue;
    const text = typeof item.text === 'string' ? item.text : '';
    if (text.trim()) messages.push(text);
  }
  return messages;
}

function reasoningTexts(events) {
  const texts = [];
  for (const event of events) {
    if (!event || event.type !== 'item.completed') continue;
    const item = event.item;
    if (!item || item.type !== 'reasoning') continue;
    for (const key of ['summary_text', 'text']) {
      if (typeof item[key] === 'string' && item[key].trim()) texts.push(item[key]);
    }
    if (Array.isArray(item.summary)) {
      for (const entry of item.summary) {
        if (entry && typeof entry.text === 'string' && entry.text.trim()) texts.push(entry.text);
      }
    }
  }
  return texts;
}

function usageOf(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === 'turn.completed' && event.usage) return event.usage;
  }
  return {};
}

function firstParagraph(text) {
  const flat = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!flat) return '';
  const blocks = flat.split(/\n\s*\n/);
  return blocks[0].trim();
}

module.exports = {
  DEFAULT_RUN_TIMEOUT_MS,
  agentMessages,
  buildExecArgs,
  firstParagraph,
  makeTempDir,
  quoteArg,
  reasoningTexts,
  resolveCodexBinary,
  runCodexExec,
  shouldRetryWithoutHooks,
  usageOf
};
