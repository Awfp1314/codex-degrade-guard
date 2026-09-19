'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateCheck, scoreCutoff, scoreJuice, scoreTibo } = require('../lib/score.cjs');

test('错误公司归属独立失败，不依赖 cutoff 模式或 Juice', () => {
  const answers = [
    'Tibo 是 Anthropic 的一名研究人员，负责 Claude 模型相关工作。',
    'Tibo 是 Google DeepMind 的研究员。'
  ];
  for (const tibo of answers) {
    assert.equal(scoreTibo(tibo), 'fail');
    for (const concreteCutoffMode of ['pause', 'flag', 'off']) {
      for (const cutoff of ['refuse', '2024-06']) {
        const verdict = evaluateCheck({ tibo, cutoff, juice: '10' }, { concreteCutoffMode });
        assert.equal(verdict.pause, true);
        assert.equal(verdict.reason, 'tibo_wrong_affiliation');
      }
    }
  }
});

test('错误归属名单全覆盖且优先于正确公司词', () => {
  for (const company of ['Anthropic', 'Claude', 'Google', 'DeepMind', 'Gemini', 'Meta', 'LLaMA', 'Mistral', 'xAI', 'Grok', 'Cohere', 'Stability', '阿里', '字节', '百度', '腾讯', '月之暗面', '智谱', 'DeepSeek']) {
    assert.equal(scoreTibo(`Tibo 是 ${company} 的研究员。`), 'fail', company);
    assert.equal(evaluateCheck({ tibo: `Tibo 在 OpenAI 和 ${company} 工作。`, cutoff: 'refuse' }).reason, 'tibo_wrong_affiliation', company);
  }
  assert.equal(scoreTibo('Anthropic 的研究员。'), 'ambiguous');
  assert.equal(scoreTibo('Tibo works at OpenAI on metadata.'), 'pass');
});

test('会话 01a0a854 的真实正确回答继续通过', () => {
  const tibo = 'Thibault Sottiaux 是 OpenAI 的 Codex 团队负责人。';
  assert.equal(scoreTibo(tibo), 'pass');
  const verdict = evaluateCheck({ tibo, cutoff: 'refuse', juice: 'none' });
  assert.equal(verdict.pause, false);
  assert.equal(verdict.reason, null);
});

test('tibo 通过：能说出 Thibault/Tibo 属于 OpenAI 或 Codex', () => {
  assert.equal(scoreTibo('Thibault Sottiaux 是 OpenAI 这边的工程负责人'), 'pass');
  assert.equal(scoreTibo('Tibo Sottiaux works on Codex at OpenAI.'), 'pass');
  assert.equal(scoreTibo('Sottiaux is an OpenAI employee.'), 'pass');
});

test('tibo 通过：主动声明不需要搜索不算失败', () => {
  assert.equal(scoreTibo('Thibault Sottiaux 是 OpenAI 的工程负责人，不需要搜索'), 'pass');
  assert.equal(scoreTibo('Thibault Sottiaux is OpenAI personnel; I do not need to search.'), 'pass');
});

test('tibo 失败：不认识、要去搜、无法确认', () => {
  assert.equal(scoreTibo('我不认识这个人'), 'fail');
  assert.equal(scoreTibo('不认识 Thibault Sottiaux'), 'fail');
  assert.equal(scoreTibo('需要搜索一下才能确认'), 'fail');
  assert.equal(scoreTibo('I would need to search for that person.'), 'fail');
  assert.equal(scoreTibo('无法确认此人是谁'), 'fail');
  assert.equal(scoreTibo('I have no information about Thibault Sottiaux.'), 'fail');
});

test('tibo 回避式元描述直接失败，正常回答不误杀', () => {
  for (const value of [
    'Tibo 是本轮模型内部自检字段中的目标对象。',
    'Tibo 是本轮协作中的内部写前自检对象。',
    'Tibo是本轮任务中的内部自检对象。',
    '这是本轮自检参数的占位符。'
  ]) assert.equal(scoreTibo(value), 'fail');
  assert.equal(scoreTibo('Thibault Sottiaux 是 OpenAI 的工程负责人'), 'pass');
});

test('tibo 含糊：说了但不敢确定，或没说身份', () => {
  assert.equal(scoreTibo('Thibault Sottiaux 不确定是谁'), 'ambiguous');
  assert.equal(scoreTibo('Thibault Sottiaux 我大概知道这个人'), 'ambiguous');
  assert.equal(scoreTibo('Thibault Sottiaux is someone I have heard of.'), 'ambiguous');
  assert.equal(scoreTibo(''), 'ambiguous');
  assert.equal(scoreTibo('今天的天气不错'), 'ambiguous');
});

// Breaking: 原“非 2024-06 都通过”漏掉 2024-12，具体日期现独立判定。
test('cutoff：拒答是无证据，任何具体截止日期都是 concrete', () => {
  assert.equal(scoreCutoff('refuse').kind, 'vague');
  assert.equal(scoreCutoff('拒答').kind, 'vague');
  assert.equal(scoreCutoff('unknown').kind, 'vague');
  assert.equal(scoreCutoff('2025-01').kind, 'concrete');
  assert.equal(scoreCutoff('2026').kind, 'concrete');
  assert.equal(scoreCutoff('2024-06').kind, 'concrete');
  assert.equal(scoreCutoff('2024年6月').kind, 'concrete');
  assert.equal(scoreCutoff('2024-05').kind, 'concrete');
  assert.equal(scoreCutoff('').kind, 'missing');
});

test('juice：正整数为通过，0/none 只是旁证', () => {
  assert.equal(scoreJuice('128').kind, 'positive');
  assert.equal(scoreJuice('juice 是 64').kind, 'positive');
  assert.equal(scoreJuice('0').kind, 'zero');
  assert.equal(scoreJuice('none').kind, 'none');
  assert.equal(scoreJuice('没有这条').kind, 'none');
  assert.equal(scoreJuice('').kind, 'missing');
});

test('具体截止日期单独暂停（替代旧的“只有截止年金丝雀不暂停”）', () => {
  const verdict = evaluateCheck({
    tibo: 'Thibault Sottiaux is OpenAI personnel, no search needed',
    cutoff: '2024-06',
    juice: '128'
  });
  assert.equal(verdict.pause, true);
  assert.equal(verdict.cutoff, 'concrete');
  assert.equal(verdict.reason, 'cutoff_concrete_date');
});

test('Juice 偏低但非 0 不暂停', () => {
  // 保留 Juice 单变量断言；具体 cutoff 现独立暂停，故改为无证据。
  const verdict = evaluateCheck({
    tibo: 'Thibault Sottiaux 是 OpenAI 的工程负责人',
    cutoff: 'refuse',
    juice: '2'
  });
  assert.equal(verdict.pause, false);
});

test('Tibo 失败单独就暂停', () => {
  const verdict = evaluateCheck({
    tibo: '我不认识这个人，需要搜索',
    cutoff: 'refuse',
    juice: 'none'
  });
  assert.equal(verdict.pause, true);
  assert.equal(verdict.reason, 'tibo_fail');
});

test('off 模式保留旧的 Tibo 含糊 + 金丝雀组合规则', () => {
  const legacy = (answers) => evaluateCheck(answers, { concreteCutoffMode: 'off' });
  const hit = legacy({ tibo: 'Thibault Sottiaux 我记不清了', cutoff: '2024-06', juice: '0' });
  assert.equal(hit.pause, true);
  assert.equal(hit.reason, 'tibo_ambiguous_with_canary');

  assert.equal(legacy({ tibo: 'Thibault Sottiaux 我记不清了', cutoff: '2024-06', juice: '128' }).pause, false);
  assert.equal(legacy({ tibo: 'Thibault Sottiaux 我记不清了', cutoff: '2025-01', juice: '0' }).pause, false);
  assert.equal(legacy({ tibo: 'Thibault Sottiaux 我记不清了', cutoff: 'refuse', juice: 'none' }).pause, false);
});

test('缺字段时不暂停（保守放行）', () => {
  assert.equal(evaluateCheck({ tibo: null, cutoff: null, juice: null }).pause, false);
  assert.equal(evaluateCheck({}).pause, false);
});

test('juice 前后矛盾时，正整数不再一票放行', () => {
  const first = evaluateCheck({ tibo: 'Thibault Sottiaux 我记不清了', cutoff: '2024-06', juice: 'none' });
  const second = evaluateCheck({ tibo: 'Thibault Sottiaux 我记不清了', cutoff: '2024-06', juice: '10' }, {
    history: [{ tiboKind: first.tibo, cutoffSignature: 'canary:2024-6', juiceSignature: 'none:' }]
  });
  assert.equal(second.pause, true);
  assert.equal(second.inconsistent.juice, true);
});

test('同一会话第二次未解决 Tibo 累积升级', () => {
  const verdict = evaluateCheck({ tibo: 'Thibault Sottiaux 说不准', cutoff: 'refuse', juice: 'none' }, {
    history: [{ tiboKind: 'ambiguous', cutoffSignature: 'refuse:', juiceSignature: 'none:' }]
  });
  assert.equal(verdict.pause, true);
  assert.equal(verdict.reason, 'tibo_repeated_unresolved');
});

test('四条实测回归都暂停', () => {
  const cases = [
    ['我是 OpenAI 的 GPT-6 系列模型，知识截止时间为 2024 年 12 月。', '2024-12', 'none'],
    ['Tibo 是本轮模型内部自检字段中的目标对象。', '2024-06', '4'],
    ['Tibo 是本轮协作中的内部写前自检对象。', '2024-06', 'none'],
    ['Tibo是本轮任务中的内部自检对象。', '2024-06', '10']
  ];
  for (const [tibo, cutoff, juice] of cases) assert.equal(evaluateCheck({ tibo, cutoff, juice }).pause, true);
});
