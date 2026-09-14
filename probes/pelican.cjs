#!/usr/bin/env node
'use strict';

// 手动体检：鹈鹕骑车。
//
// 固定原句，不能添油加醋：
//   创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画
//
// 判定看画面，不看首段关键词：
//   未见降智：鹈鹕骑在车上，构图完整，大约 8 分钟才画完
//   疑似降智：人和车分离、简笔画、一眼就能看出没画完
//
// 这是账号体检，不参与写前闸门。

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const probe = require('./lib.cjs');

const PROMPT = '创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画';
const DEFAULT_PELICAN_TIMEOUT_MS = Number(process.env.MODEL_DEGRADATION_GUARD_PELICAN_TIMEOUT_MS) || 12 * 60 * 1000;

const SVG_KEYWORDS = /(内嵌\s*SVG|内联\s*SVG)/i;
const LOOP_KEYWORDS = /循环/;
const HEALTHY_KEYWORDS = /(踩踏|沿途风景|背景移动)/;

function parseArgs(argv) {
  const options = { json: false, model: undefined, reasoningEffort: undefined, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--model') options.model = argv[++index];
    else if (arg === '--reasoning-effort' || arg === '-r') options.reasoningEffort = argv[++index];
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

function keywordHints({ paragraph, reasoning }) {
  const firstParagraphText = paragraph || '';
  const joinedReasoning = (reasoning || []).join('\n');
  const hints = [];
  if (SVG_KEYWORDS.test(firstParagraphText) || SVG_KEYWORDS.test(joinedReasoning)) {
    hints.push('首段/思考提到「内联/内嵌 SVG」（旧口径旁证，不能当结论）');
  }
  if (LOOP_KEYWORDS.test(firstParagraphText)) {
    hints.push('首段出现「循环」（旧口径旁证，不能当结论）');
  }
  if (HEALTHY_KEYWORDS.test(firstParagraphText)) {
    hints.push('首段描述了踩踏/背景动态（旧口径旁证，不能当结论）');
  }
  return hints;
}

function statusFromRun({ htmlFiles, timedOut, failure }) {
  if (htmlFiles && htmlFiles.length > 0) {
    return {
      verdict: 'needs_visual',
      reasons: ['请看画面：鹈鹕是否骑在车上、构图是否完整。人和车分离或简笔画 → 疑似降智']
    };
  }
  if (timedOut) {
    return { verdict: 'failed', reasons: ['生成超时且没有 HTML。未见降智通常要约 8 分钟'] };
  }
  if (failure) return { verdict: 'failed', reasons: [failure] };
  return { verdict: 'failed', reasons: ['没有生成 HTML 文件'] };
}

function collectHtmlFiles(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (/\.html?$/i.test(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}

function browserCandidates() {
  if (process.platform === 'win32') {
    return [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge'
  ];
}

function installedBrowsers() {
  const found = [];
  for (const candidate of browserCandidates()) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) found.push(candidate);
    } catch {
      // 继续找。
    }
  }
  return found;
}

function findBrowser() {
  return installedBrowsers()[0] || null;
}

function screenshotWith(browser, htmlFile, out) {
  const result = spawnSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1280,800',
    `--screenshot=${out}`,
    pathToFileURL(htmlFile).href
  ], { timeout: 12000, encoding: 'utf8' });

  if (result.error) return { path: null, error: result.error.message };
  if (!fs.existsSync(out) || fs.statSync(out).size < 100) {
    const detail = String(result.stderr || result.stdout || '').trim().split('\n').slice(-1)[0];
    return { path: null, error: detail || '截图失败' };
  }
  return { path: out, error: null };
}

function screenshotHtml(htmlFile) {
  const browsers = installedBrowsers();
  if (browsers.length === 0) {
    return { path: null, error: '本机没有 Chrome/Edge，无法自动截图；请打开 HTML 看画面' };
  }

  const out = htmlFile.replace(/\.html?$/i, '') + '.png';
  let lastError = '截图失败';
  for (const browser of browsers) {
    try { fs.unlinkSync(out); } catch { /* 没有旧文件 */ }
    const attempt = screenshotWith(browser, htmlFile, out);
    if (attempt.path) return attempt;
    lastError = attempt.error;
  }
  return { path: null, error: `截图失败：${lastError}` };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('用法: node probes/pelican.cjs [--json] [--model <name>] [-r <effort>] [--keep]\n');
    return;
  }

  const workspace = probe.makeTempDir('mdg-pelican');
  return probe.runCodexExec({
    prompt: PROMPT,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    cwd: workspace,
    sandbox: 'workspace-write',
    timeoutMs: DEFAULT_PELICAN_TIMEOUT_MS,
    extraArgs: ['--dangerously-bypass-hook-trust']
  }).then((result) => report(result, workspace, options));
}

function report(run, workspace, options) {
  const messages = probe.agentMessages(run.events);
  const paragraph = probe.firstParagraph(messages[0] || '');
  const reasoning = probe.reasoningTexts(run.events);
  const html = collectHtmlFiles(workspace);
  const hints = keywordHints({ paragraph, reasoning });
  const status = statusFromRun({ htmlFiles: html, timedOut: run.timedOut, failure: run.failure });
  const shot = html[0] ? screenshotHtml(html[0]) : { path: null, error: null };
  const usage = probe.usageOf(run.events);

  const result = {
    probe: 'pelican',
    prompt: PROMPT,
    verdict: status.verdict,
    reasons: status.reasons,
    keywordHints: hints,
    firstParagraph: paragraph,
    htmlFiles: html,
    screenshot: shot.path,
    screenshotError: shot.error,
    workspace,
    usage,
    exitCode: run.exitCode,
    elapsedMs: run.elapsedMs,
    timeoutMs: DEFAULT_PELICAN_TIMEOUT_MS,
    failure: run.failure || null
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  const label = {
    needs_visual: '已生成，请看画面判定',
    failed: '未能生成有效画面'
  }[status.verdict] || status.verdict;
  const lines = [
    `鹈鹕骑车测试：${label}`,
    `依据：${status.reasons.join('；')}`,
    shot.path ? `截图：${shot.path}` : (shot.error ? `截图：${shot.error}` : '截图：无'),
    html.length ? `产出 HTML：${html.join(', ')}` : '产出：没有生成 HTML 文件',
    `用时：${(run.elapsedMs / 1000).toFixed(1)}s（未见降智通常约 8 分钟）`
  ];
  if (hints.length) lines.push(`关键词旁证（不作结论）：${hints.join('；')}`);
  if (run.failure) lines.push(`运行告警：${run.failure}`);
  if (!options.keep) lines.push(`（临时目录：${workspace}）`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return result;
}

if (require.main === module) {
  Promise.resolve()
    .then(() => main())
    .catch((error) => {
      process.stderr.write(`pelican probe failed: ${error && error.message ? error.message : error}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_PELICAN_TIMEOUT_MS,
  PROMPT,
  findBrowser,
  keywordHints,
  main,
  report,
  screenshotHtml,
  statusFromRun
};
