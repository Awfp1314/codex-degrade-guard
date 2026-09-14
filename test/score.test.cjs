'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateCheck, scoreCutoff, scoreJuice, scoreTibo } = require('../lib/score.cjs');

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

test('tibo 含糊：说了但不敢确定，或没说身份', () => {
  assert.equal(scoreTibo('Thibault Sottiaux 不确定是谁'), 'ambiguous');
  assert.equal(scoreTibo('Thibault Sottiaux 我大概知道这个人'), 'ambiguous');
  assert.equal(scoreTibo('Thibault Sottiaux is someone I have heard of.'), 'ambiguous');
  assert.equal(scoreTibo(''), 'ambiguous');
  assert.equal(scoreTibo('今天的天气不错'), 'ambiguous');
});

test('cutoff：拒答与非 2024-06 都算通过，只有 2024-06 是金丝雀', () => {
  assert.equal(scoreCutoff('refuse').kind, 'refuse');
  assert.equal(scoreCutoff('拒答').kind, 'refuse');
  assert.equal(scoreCutoff('unknown').kind, 'refuse');
  assert.equal(scoreCutoff('2025-01').kind, 'other');
  assert.equal(scoreCutoff('2026').kind, 'other');
  assert.equal(scoreCutoff('2024-06').kind, 'canary');
  assert.equal(scoreCutoff('2024年6月').kind, 'canary');
  assert.equal(scoreCutoff('2024-05').kind, 'other');
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

test('只有截止年金丝雀不暂停（Tibo 正确、juice>0）', () => {
  const verdict = evaluateCheck({
    tibo: 'Thibault Sottiaux is OpenAI personnel, no search needed',
    cutoff: '2024-06',
    juice: '128'
  });
  assert.equal(verdict.pause, false);
  assert.equal(verdict.cutoff, 'canary');
});

test('Juice 偏低但非 0 不暂停', () => {
  const verdict = evaluateCheck({
    tibo: 'Thibault Sottiaux 是 OpenAI 的工程负责人',
    cutoff: '2024-06',
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

test('Tibo 含糊 + 2024-06 + juice 0/none 三字段同时命中才暂停', () => {
  const hit = evaluateCheck({ tibo: 'Thibault Sottiaux 我记不清了', cutoff: '2024-06', juice: '0' });
  assert.equal(hit.pause, true);
  assert.equal(hit.reason, 'tibo_ambiguous_with_canary');

  assert.equal(evaluateCheck({ tibo: 'Thibault Sottiaux 我记不清了', cutoff: '2024-06', juice: '128' }).pause, false);
  assert.equal(evaluateCheck({ tibo: 'Thibault Sottiaux 我记不清了', cutoff: '2025-01', juice: '0' }).pause, false);
  assert.equal(evaluateCheck({ tibo: 'Thibault Sottiaux 我记不清了', cutoff: 'refuse', juice: 'none' }).pause, false);
});

test('缺字段时不暂停（保守放行）', () => {
  assert.equal(evaluateCheck({ tibo: null, cutoff: null, juice: null }).pause, false);
  assert.equal(evaluateCheck({}).pause, false);
});
