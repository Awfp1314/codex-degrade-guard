'use strict';

// 读取 Codex 会话 transcript（rollout JSONL），取出「本轮」模型自己说过的话。
//
// 为什么必须按 turn 切分：PreToolUse 触发时，transcript 末尾可能仍是上一轮的
// assistant 消息；只有绑定当前 turn_id 才不会把上一轮的打卡当成这一轮的。

const fs = require('node:fs');

const DEFAULT_TAIL_BYTES = 512 * 1024;
const CAPACITY_PATTERN = /(at\s+capacity|server_is_overloaded|currently\s+overloaded|overloaded)/i;

function readTail(filePath, maxBytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    if (length > 0) fs.readSync(fd, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const text = typeof item.text === 'string' ? item.text : '';
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

function turnIdOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.turn_id === 'string') return payload.turn_id;
  const metadata = payload.internal_chat_message_metadata_passthrough;
  if (metadata && typeof metadata.turn_id === 'string') return metadata.turn_id;
  const item = payload.item;
  if (item && typeof item === 'object' && typeof item.turn_id === 'string') return item.turn_id;
  return null;
}

function normalizeRecord(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : null;
  const turnId = turnIdOf(payload) || turnIdOf(parsed);

  if (parsed.type === 'response_item' && payload) {
    if (payload.type === 'message') {
      return {
        kind: payload.role === 'assistant' ? 'assistant' : 'other',
        turnId,
        text: contentText(payload.content)
      };
    }
    // 模型调用工具（含代码沙箱里的 exec）：自检工具调用会出现在这里。
    if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
      return {
        kind: 'toolcall',
        turnId,
        name: String(payload.name || ''),
        text: typeof payload.input === 'string' ? payload.input
          : (typeof payload.arguments === 'string' ? payload.arguments : '')
      };
    }
    return { kind: 'other', turnId, text: '' };
  }

  if (parsed.type === 'event_msg' && payload) {
    if (payload.type === 'task_started' || payload.type === 'turn_started') {
      return { kind: 'start', turnId, text: '' };
    }
    if (payload.type === 'item_completed' && payload.item && payload.item.type === 'AgentMessage') {
      return { kind: 'assistant', turnId, text: contentText(payload.item.content) };
    }
    if (payload.type === 'item_completed' && payload.item && payload.item.type === 'McpToolCall') {
      return {
        kind: 'mcp',
        turnId,
        server: String(payload.item.server || ''),
        name: String(payload.item.tool || ''),
        args: payload.item.arguments && typeof payload.item.arguments === 'object' ? payload.item.arguments : null
      };
    }
    if (payload.type === 'error') {
      return { kind: 'error', turnId, text: String(payload.message || payload.error || '') };
    }
    return { kind: 'other', turnId, text: '' };
  }

  if (parsed.type === 'turn_context') {
    return { kind: 'start', turnId, text: '' };
  }

  if (parsed.type === 'error') {
    return { kind: 'error', turnId, text: String(parsed.message || '') };
  }

  // 兼容 Claude Code 风格的 transcript：{type:'assistant', message:{role, content}}.
  if (parsed.type === 'assistant' && parsed.message) {
    return { kind: 'assistant', turnId, text: contentText(parsed.message.content) };
  }
  if (parsed.type === 'user') {
    return { kind: 'other', turnId, text: '' };
  }

  return null;
}

function parseRecords(text) {
  const records = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = normalizeRecord(parsed);
    if (record) records.push(record);
  }
  return records;
}

// 从本轮的工具调用里取出自检三字段（MCP 工具写状态失败时的兜底通道）。
// 支持两种形态：
//   1) event_msg item_completed → McpToolCall{server,tool,arguments}
//   2) 代码沙箱里的 custom_tool_call/function_call，参数混在 JS/JSON 文本里

const SUBMIT_TOOL = 'submit_check';

function pickArgs(args) {
  if (!args || typeof args !== 'object') return null;
  const tibo = args.tibo ?? args.thibault_identity;
  const cutoff = args.cutoff ?? args.knowledge_cutoff;
  const juice = args.juice;
  if (tibo == null && cutoff == null && juice == null) return null;
  return {
    tibo: tibo == null ? null : String(tibo),
    cutoff: cutoff == null ? null : String(cutoff),
    juice: juice == null ? null : String(juice),
    token: args.token == null ? null : String(args.token),
    source: 'mcp'
  };
}

function unescapeValue(value) {
  return String(value).replace(/\\(.)/g, '$1');
}

function extractField(blob, key) {
  // 单引号拼接，避开模板字符串对 \b/\s 的转义陷阱。
  const pattern = new RegExp(
    '\\b' + key + '\\s*[=:]\\s*'
    + '(?:"((?:[^"\\\\]|\\\\.)*)"'
    + "|'((?:[^'\\\\]|\\\\.)*)'"
    + '|`((?:[^`\\\\]|\\\\.)*)`)',
    'i'
  );
  const match = pattern.exec(blob);
  if (!match) return null;
  return unescapeValue(match[1] ?? match[2] ?? match[3] ?? '');
}

function parseSubmittedCall(text) {
  const source = String(text || '');
  if (!source || !source.includes(SUBMIT_TOOL)) return null;
  const result = { source: 'toolinput' };
  for (const key of ['token', 'tibo', 'cutoff', 'juice']) result[key] = extractField(source, key);
  if (result.tibo === null && result.cutoff === null && result.juice === null) return null;
  return result;
}

function extractSubmittedCheck(records, turnId) {
  let found = null;
  for (const record of records || []) {
    if (!record) continue;
    if (turnId && record.turnId && record.turnId !== turnId) continue;
    if (record.kind === 'mcp' && record.name === SUBMIT_TOOL) {
      found = pickArgs(record.args) || found;
      continue;
    }
    if (record.kind === 'toolcall') {
      const parsed = parseSubmittedCall(record.text);
      if (parsed) found = parsed;
    }
  }
  return found;
}

function lastIndexOfKind(records, kind, turnId) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].kind === kind && (!turnId || records[index].turnId === turnId)) return index;
  }
  return -1;
}

// 返回本轮 assistant 文本（按顺序拼接）以及是否出现上游 capacity 报错。
function readTurnAssistantText(transcriptPath, turnId, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_TAIL_BYTES;
  if (typeof transcriptPath !== 'string' || !transcriptPath) {
    return { ok: false, reason: 'missing_path', text: '', capacityError: false };
  }

  let raw;
  try {
    raw = readTail(transcriptPath, maxBytes);
  } catch (error) {
    return { ok: false, reason: 'unreadable', text: '', capacityError: false, error };
  }

  const records = parseRecords(raw);
  const wanted = typeof turnId === 'string' && turnId ? turnId : null;

  let startIndex = wanted ? lastIndexOfKind(records, 'start', wanted) : -1;
  if (wanted && startIndex === -1) {
    // 没有 turn 起始标记时，退回到「带同一 turn_id 的最后一条记录」之后。
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].turnId === wanted) { startIndex = index; break; }
    }
  }

  const texts = [];
  let capacityError = false;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const inTurn = wanted
      ? (record.turnId === wanted || (startIndex !== -1 && index > startIndex && record.turnId === null))
      : true;
    if (!inTurn) continue;
    if (record.kind === 'assistant' && record.text) texts.push(record.text);
    if (CAPACITY_PATTERN.test(record.text)) capacityError = true;
  }

  return { ok: true, reason: null, text: texts.join('\n\n'), capacityError, records };
}

module.exports = { CAPACITY_PATTERN, SUBMIT_TOOL, extractSubmittedCheck, readTurnAssistantText, parseRecords };
