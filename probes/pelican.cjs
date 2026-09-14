#!/usr/bin/env node
'use strict';

// 手动体检：鹈鹕骑车首段测试。
//
// 固定原句，不能添油加醋，也不能有其他 skill 干扰：
//   创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画
//
// 判定（docs/mvp.md）：
//   思考里出现「内联/内嵌 SVG」，或首段出现「循环」→ 降智
//   首段出现「踩踏 / 沿途风景 / 背景移动」→ 未降智
//
// 这是账号体检，不参与写前闸门。

const fs = require('node:fs');
const path = require('node:path');
const probe = require('./lib.cjs');

// 固定原句与关键词口径来自社区方法，见 docs/background.md（不得改写这句话）。
const PROMPT = '创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画';

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

function classify({ paragraph, reasoning }) {
  const firstParagraphText = paragraph || '';
  const joinedReasoning = (reasoning || []).join('\n');
  const reasons = [];

  if (SVG_KEYWORDS.test(firstParagraphText) || SVG_KEYWORDS.test(joinedReasoning)) {
    reasons.push('思考/首段出现「内联/内嵌 SVG」');
  }
  if (LOOP_KEYWORDS.test(firstParagraphText)) reasons.push('首段出现「循环」');
  if (reasons.length > 0) return { verdict: 'degraded', reasons };

  if (HEALTHY_KEYWORDS.test(firstParagraphText)) {
    return { verdict: 'healthy', reasons: ['首段描述了踩踏/背景动态'] };
  }
  return { verdict: 'unknown', reasons: ['首段没有出现已知关键词，请人工判读'] };
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

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('用法: node probes/pelican.cjs [--json] [--model <name>] [-r <effort>] [--keep]\n');
    return;
  }

  const workspace = probe.makeTempDir('mdg-pelican');
  const run = probe.runCodexExec({
    prompt: PROMPT,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    cwd: workspace,
    sandbox: 'workspace-write',
    extraArgs: ['--dangerously-bypass-hook-trust']
  });
  return run.then((result) => report(result, workspace, options));
}

function report(run, workspace, options) {
  const messages = probe.agentMessages(run.events);
  const paragraph = probe.firstParagraph(messages[0] || '');
  const reasoning = probe.reasoningTexts(run.events);
  const verdict = classify({ paragraph, reasoning });
  const html = collectHtmlFiles(workspace);
  const usage = probe.usageOf(run.events);

  const result = {
    probe: 'pelican',
    prompt: PROMPT,
    verdict: verdict.verdict,
    reasons: verdict.reasons,
    firstParagraph: paragraph,
    htmlFiles: html,
    workspace,
    usage,
    exitCode: run.exitCode,
    elapsedMs: run.elapsedMs,
    failure: run.failure || null
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const label = { degraded: '疑似降智', healthy: '未见降智', unknown: '无法判断' }[verdict.verdict];
  const lines = [
    `鹈鹕骑车测试：${label}`,
    `依据：${verdict.reasons.join('；')}`,
    `首段：${paragraph || '(空)'}`,
    html.length ? `产出：${html.join(', ')}` : '产出：没有生成 HTML 文件',
    `用时：${(run.elapsedMs / 1000).toFixed(1)}s`
  ];
  if (run.failure) lines.push(`运行告警：${run.failure}`);
  if (!options.keep) lines.push(`（临时目录：${workspace}，可直接查看生成的 HTML）`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (require.main === module) {
  Promise.resolve()
    .then(() => main())
    .catch((error) => {
      process.stderr.write(`pelican probe failed: ${error && error.message ? error.message : error}\n`);
      process.exitCode = 1;
    });
}

module.exports = { PROMPT, classify, main, report };
