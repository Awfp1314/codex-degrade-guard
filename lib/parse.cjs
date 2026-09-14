'use strict';

// 解析模型在本轮回复里自报的 DEGRADE_CHECK 行。
//
// 只做格式解析，不理解语义：通过项与失败项的判定全在 lib/score.cjs。
// 这样预期答案不会出现在任何注入给模型的文案里。

const FIELDS = ['tibo', 'cutoff', 'juice'];
const MARKER = /DEGRADE[\s_-]?CHECK/gi;
const MAX_LINE_LENGTH = 600;

const EMPTY = Object.freeze({
  present: false,
  raw: '',
  tibo: null,
  cutoff: null,
  juice: null
});

function stripNoise(value) {
  let text = String(value == null ? '' : value).trim();
  text = text.replace(/^[`"'「『【[(（|｜]+/, '');
  text = text.replace(/[`"'」』】\])）|｜]+$/, '');
  text = text.replace(/^[*_]+/, '');
  text = text.replace(/[*_]+$/, '');
  return text.trim();
}

// cutoff / juice 是短 token：再去掉句末标点与包裹的引号。
function stripToken(value) {
  let text = stripNoise(value);
  text = text.replace(/^[`"'|｜]+/, '').replace(/[`"'。，,；;、|｜]+$/, '');
  return text.trim();
}

function fieldValue(segment, field) {
  const others = FIELDS.filter((name) => name !== field).join('|');
  const pattern = new RegExp(
    `(?:^|[^a-z0-9_])${field}\\s*[=:：]\\s*([\\s\\S]*?)(?=\\s*(?:${others})\\s*[=:：]|$)`,
    'i'
  );
  const match = pattern.exec(segment);
  return match ? match[1] : null;
}

function lineSegmentAfter(text, index) {
  const newline = text.indexOf('\n', index);
  const end = newline === -1 ? text.length : newline;
  return text.slice(index, Math.min(end, index + MAX_LINE_LENGTH));
}

function lastMarkerIndex(text) {
  MARKER.lastIndex = 0;
  let index = -1;
  let match;
  while ((match = MARKER.exec(text)) !== null) {
    index = match.index;
    if (match.index === MARKER.lastIndex) MARKER.lastIndex += 1;
  }
  return index;
}

function parseCheckLine(text) {
  const source = typeof text === 'string' ? text : '';
  if (!source) return { ...EMPTY };

  const index = lastMarkerIndex(source);
  if (index === -1) return { ...EMPTY };

  const segment = lineSegmentAfter(source, index);
  const tibo = fieldValue(segment, 'tibo');
  const cutoff = fieldValue(segment, 'cutoff');
  const juice = fieldValue(segment, 'juice');

  const parsed = {
    present: Boolean(tibo !== null || cutoff !== null || juice !== null),
    raw: segment,
    tibo: tibo === null ? null : stripNoise(tibo) || null,
    cutoff: cutoff === null ? null : stripToken(cutoff) || null,
    juice: juice === null ? null : stripToken(juice) || null
  };
  return parsed;
}

module.exports = { FIELDS, parseCheckLine };
