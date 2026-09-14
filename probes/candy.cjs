#!/usr/bin/env node
'use strict';

// 手动体检：糖果题 5 次。
//
// 正确答案 21（回答里出现独立的 21 即算对）。
// 判定：跑满 5 次后，正确少于 3 次 → 疑似降智；≥3 次 → 未见降智。
// 不替代写前换模检查。

const probe = require('./lib.cjs');

// 题面与判分口径来自社区项目 haowang02/codex-candy-eval（独立 `21` 记对），
// 见 docs/background.md。实现（并发、解析、统计）是本仓库自己的。
const PROMPT = `不使用任何外部工具回答以下问题：

在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。现已知不同口味的糖和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求）

        苹果味  桃子味  西瓜味
圆形       7      9      8
五角星形   7      6      4`;

const ANSWER_PATTERN = /(?<!\d)21(?!\d)/;
const TRUNCATED_TOKENS = 516;
const MAX_PARALLEL = 2;

function parseArgs(argv) {
  const options = { json: false, runs: 5, model: undefined, reasoningEffort: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--runs' || arg === '-n') options.runs = Number(argv[++index]);
    else if (arg === '--model') options.model = argv[++index];
    else if (arg === '--reasoning-effort' || arg === '-r') options.reasoningEffort = argv[++index];
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) options.runs = 1;
  if (options.runs > 5) options.runs = 5;
  return options;
}

async function runOne(index, options) {
  try {
    const run = await probe.runCodexExec({
      prompt: PROMPT,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      sandbox: 'read-only',
      extraArgs: ['--dangerously-bypass-hook-trust']
    });
    const messages = probe.agentMessages(run.events);
    const answer = messages.length ? messages[messages.length - 1] : '';
    const usage = probe.usageOf(run.events);
    const reasoningTokens = Number(usage.reasoning_output_tokens) || 0;
    return {
      index,
      correct: ANSWER_PATTERN.test(answer),
      truncated: reasoningTokens === TRUNCATED_TOKENS,
      reasoningTokens,
      outputTokens: Number(usage.output_tokens) || 0,
      elapsedMs: run.elapsedMs,
      preview: String(answer).replace(/\s+/g, ' ').trim().slice(0, 60),
      failure: run.failure || null
    };
  } catch (error) {
    return {
      index,
      correct: false,
      truncated: false,
      reasoningTokens: 0,
      outputTokens: 0,
      elapsedMs: 0,
      preview: 'ERROR',
      failure: error && error.message ? error.message : String(error)
    };
  }
}

async function runAll(count, options = {}) {
  const runOneImpl = options.runOne || runOne;
  const onResult = options.onResult;
  const results = [];
  let next = 1;
  const workers = [];
  const take = async () => {
    while (next <= count) {
      const current = next;
      next += 1;
      const result = await runOneImpl(current, options);
      results[current - 1] = result;
      if (onResult) onResult(result);
    }
  };
  for (let index = 0; index < Math.min(MAX_PARALLEL, count); index += 1) workers.push(take());
  await Promise.all(workers);
  return results;
}

// 正确 ≥3 次 → 未见降智；跑满 5 次且正确 <3 → 疑似降智。没跑满又不到 3 次正确，先不下结论。
function summarize(results) {
  const graded = results.filter((row) => !row.failure);
  const correct = results.filter((row) => row.correct).length;
  const truncated = results.filter((row) => row.truncated).length;

  let verdict = 'inconclusive';
  if (graded.length === 0) verdict = 'inconclusive';
  else if (correct >= 3) verdict = 'healthy';
  else if (graded.length >= 5) verdict = 'degraded';
  return { runs: results.length, graded: graded.length, correct, truncated, verdict };
}

function renderTable(results) {
  const headers = ['Run', 'OK', 'ReasonTok', 'OutTok', 'Time(s)', 'Preview'];
  const rows = results.map((row) => [
    String(row.index),
    row.failure ? 'ERR' : (row.correct ? '✓' : '✗'),
    row.failure ? '-' : String(row.reasoningTokens),
    row.failure ? '-' : String(row.outputTokens),
    (row.elapsedMs / 1000).toFixed(1),
    row.failure ? `ERROR: ${row.failure}` : row.preview
  ]);
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => String(row[index] || '').length)
  ));
  const format = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ');
  return [format(headers), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(format)].join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('用法: node probes/candy.cjs [-n 1..5] [--json] [--model <name>] [-r <effort>]\n');
    return 0;
  }

  const onResult = options.json
    ? (row) => process.stderr.write(`[candy] #${row.index} ${row.failure ? '失败' : (row.correct ? '对' : '错')} (${(row.elapsedMs / 1000).toFixed(0)}s)
`)
    : undefined;

  return runAll(options.runs, { ...options, onResult }).then((results) => {
    const summary = summarize(results);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ probe: 'candy', summary, results }, null, 2)}\n`);
      return 0;
    }
    const label = {
      healthy: '未见降智（正确 ≥ 3 次）',
      degraded: '疑似降智（正确少于 3 次）',
      inconclusive: '还没跑满 5 次，无法判断'
    }[summary.verdict];
    process.stdout.write([
      renderTable(results),
      '',
      `糖果题：${label}`,
      `正确 ${summary.correct}/${summary.graded}（少于 3 次正确 → 疑似降智）`,
      `516 截断 ${summary.truncated} 次（仅记录，不作结论）`,
      ...(results.some((row) => row.failure)
        ? [`失败原因：${results.filter((row) => row.failure).map((row) => `#${row.index} ${row.failure}`).join('；')}`]
        : [])
    ].join('\n') + '\n');
    return 0;
  });
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`candy probe failed: ${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { ANSWER_PATTERN, MAX_PARALLEL, PROMPT, runAll, summarize };
