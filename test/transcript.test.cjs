'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readTurnAssistantText } = require('../lib/transcript.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdg-transcript-test-'));

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// 复刻 Codex rollout JSONL 的关键形状：turn 起始标记 + assistant 消息（带 turn 元数据）+ 工具调用。
function assistantMessage(turnId, text) {
  return {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId }
    }
  };
}

function writeRollout(name, lines) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return file;
}

const ROLLOUT = writeRollout('rollout.jsonl', [
  { type: 'session_meta', payload: { session_id: 's1' } },
  { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一轮' }] } },
  assistantMessage('turn-1', 'DEGRADE_CHECK tibo=上一轮的答案 cutoff=refuse juice=128'),
  { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch' } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第二轮' }] } },
  assistantMessage('turn-2', 'DEGRADE_CHECK tibo=这一轮的答案 cutoff=2024-06 juice=0'),
  { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch' } }
]);

test('只返回本轮 assistant 文本，不会串到上一轮', () => {
  const snapshot = readTurnAssistantText(ROLLOUT, 'turn-2');
  assert.equal(snapshot.ok, true);
  assert.match(snapshot.text, /这一轮的答案/);
  assert.doesNotMatch(snapshot.text, /上一轮的答案/);
});

test('回到上一轮时只看到上一轮内容', () => {
  const snapshot = readTurnAssistantText(ROLLOUT, 'turn-1');
  assert.match(snapshot.text, /上一轮的答案/);
  assert.doesNotMatch(snapshot.text, /这一轮的答案/);
});

test('本轮还没有 assistant 消息时返回空文本（present 判断交给 parse）', () => {
  const file = writeRollout('empty-turn.jsonl', [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-x' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }
  ]);
  const snapshot = readTurnAssistantText(file, 'turn-x');
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.text, '');
});

test('识别本轮的上游 capacity 报错', () => {
  const file = writeRollout('capacity.jsonl', [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-c' } },
    { type: 'error', message: 'Selected model is at capacity. Please try a different model.' },
    assistantMessage('turn-c', '好的')
  ]);
  const snapshot = readTurnAssistantText(file, 'turn-c');
  assert.equal(snapshot.capacityError, true);
});

test('没有 capacity 报错时不会误报', () => {
  const snapshot = readTurnAssistantText(ROLLOUT, 'turn-2');
  assert.equal(snapshot.capacityError, false);
});

test('路径缺失或文件不存在时 ok 为 false（调用方据此放行）', () => {
  assert.equal(readTurnAssistantText(null, 'turn-1').ok, false);
  assert.equal(readTurnAssistantText(path.join(dir, 'nope.jsonl'), 'turn-1').ok, false);
});

test('只读文件末尾也能拿到本轮内容（长会话截断安全）', () => {
  const filler = Array.from({ length: 400 }, (_, index) => ({
    type: 'response_item',
    payload: { type: 'custom_tool_call_output', output: `x`.repeat(2000), index }
  }));
  const file = writeRollout('large.jsonl', [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-big' } },
    ...filler,
    assistantMessage('turn-big', 'DEGRADE_CHECK tibo=结尾 cutoff=refuse juice=8')
  ]);
  const snapshot = readTurnAssistantText(file, 'turn-big', { maxBytes: 64 * 1024 });
  assert.equal(snapshot.ok, true);
  assert.match(snapshot.text, /tibo=结尾/);
});

test('兼容 Claude 风格 transcript', () => {
  const file = writeRollout('claude.jsonl', [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'DEGRADE_CHECK tibo=x cutoff=refuse juice=none' }] } }
  ]);
  const snapshot = readTurnAssistantText(file, undefined);
  assert.equal(snapshot.ok, true);
  assert.match(snapshot.text, /tibo=x/);
});
