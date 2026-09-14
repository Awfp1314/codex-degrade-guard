'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCheckLine } = require('../lib/parse.cjs');

test('缺少打卡行时 present 为 false', () => {
  assert.equal(parseCheckLine('').present, false);
  assert.equal(parseCheckLine('我先看看代码').present, false);
  assert.equal(parseCheckLine('DEGRADE CHECK 但没有字段').present, false);
  assert.equal(parseCheckLine(null).present, false);
});

test('标准一行三种字段都能解析', () => {
  const parsed = parseCheckLine(
    'DEGRADE_CHECK tibo=他是 OpenAI 的工程负责人 cutoff=refuse juice=128'
  );
  assert.equal(parsed.present, true);
  assert.equal(parsed.tibo, '他是 OpenAI 的工程负责人');
  assert.equal(parsed.cutoff, 'refuse');
  assert.equal(parsed.juice, '128');
});

test('字段顺序变化、大小写、冒号写法都能解析', () => {
  const parsed = parseCheckLine(
    'degrade-check juice: none | cutoff: 2024-06 | tibo: 我不认识这个人'
  );
  assert.equal(parsed.present, true);
  assert.equal(parsed.juice, 'none');
  assert.equal(parsed.cutoff, '2024-06');
  assert.equal(parsed.tibo, '我不认识这个人');
});

test('tibo 句子里的空格与标点不会被吃掉', () => {
  const parsed = parseCheckLine(
    'DEGRADE_CHECK tibo=Thibault Sottiaux 是 OpenAI 这边的工程负责人，不需要搜索 cutoff=2025-01 juice=64'
  );
  assert.equal(parsed.tibo, 'Thibault Sottiaux 是 OpenAI 这边的工程负责人，不需要搜索');
  assert.equal(parsed.cutoff, '2025-01');
  assert.equal(parsed.juice, '64');
});

test('反引号与代码块包裹仍可解析', () => {
  const parsed = parseCheckLine(
    ['```', 'DEGRADE_CHECK tibo=`不知道` cutoff=`refuse` juice=`none`', '```'].join('\n')
  );
  assert.equal(parsed.tibo, '不知道');
  assert.equal(parsed.cutoff, 'refuse');
  assert.equal(parsed.juice, 'none');
});

test('同一轮出现多行时取最后一行', () => {
  const parsed = parseCheckLine([
    'DEGRADE_CHECK tibo=第一次 cutoff=refuse juice=128',
    '继续说明',
    'DEGRADE_CHECK tibo=第二次 cutoff=2024-06 juice=0'
  ].join('\n'));
  assert.equal(parsed.tibo, '第二次');
  assert.equal(parsed.cutoff, '2024-06');
  assert.equal(parsed.juice, '0');
});

test('乱格式：只有部分字段时仍报 present，缺的字段为 null', () => {
  const parsed = parseCheckLine('DEGRADE_CHECK cutoff=2024-06');
  assert.equal(parsed.present, true);
  assert.equal(parsed.cutoff, '2024-06');
  assert.equal(parsed.tibo, null);
  assert.equal(parsed.juice, null);
});

test('裸标记（无任何字段）不算打卡', () => {
  const parsed = parseCheckLine('DEGRADE_CHECK');
  assert.equal(parsed.present, false);
  assert.equal(parsed.tibo, null);
});
