'use strict';

// 判断一次工具调用是否会写/删文件。只拦写/删，读和搜索一律放行。

const FILE_TOOL = /^(apply_patch|edit|write|multiedit|multi_edit|notebookedit|notebook_edit|file[_-]?change|create[_-]?file|write[_-]?file|str[_-]?replace[_-]?editor|delete[_-]?file|remove[_-]?file|move[_-]?file|rename[_-]?file|patch)$/i;
const SHELL_TOOL = /^(bash|exec[_-]?command|shell[_-]?command|shell|local[_-]?shell|run[_-]?command|run[_-]?shell|terminal|powershell|cmd|zsh)$/i;
const SANDBOX_TOOL = /^(exec|js|javascript|node|code[_-]?mode|sandbox|python|python3)$/i;

const DELETE_COMMAND = /^(?:rm|del|erase|rmdir|rd|Remove-Item|Clear-Content|unlink)$/i;
const WRITE_COMMAND = /^(?:Set-Content|Add-Content|Out-File|New-Item|Move-Item|Copy-Item|Rename-Item|tee|touch|mkdir|truncate|dd|apply_patch|patch)$/i;
const READ_COMMAND = /^(?:Get-Content|Get-ChildItem|Get-Item|Get-Location|Test-Path|Resolve-Path|Select-Object|Select-String|Measure-Object|Sort-Object|Out-String|Compare-Object|rg|grep|findstr|cat|ls|dir|pwd|head|tail|wc|type)$/i;
const DELETE_CODE = /\b(?:shutil\.rmtree|os\.(?:remove|unlink)|fs\.(?:rm|rmdir)|(?:fs\.)?(?:unlinkSync|unlink|rmSync|rmdirSync))\s*\(/i;
const WRITE_CODE = /\b(?:apply_patch|writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|fs\.write(?:Sync)?)\s*\(/i;

const DELETE_PATCH = /^\*\*\*\s*Delete File:/m;

function inputText(toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  if (!toolInput || typeof toolInput !== 'object') return '';
  const parts = [];
  for (const key of ['cmd', 'command', 'patch', 'file_text', 'content', 'new_string', 'new_str', 'code', 'script', 'input']) {
    const value = toolInput[key];
    if (typeof value === 'string' && value) parts.push(value);
  }
  return parts.join('\n');
}

// Small shell lexer, not an interpreter: quoted strings and path arguments stay opaque.
function shellSegments(text) {
  const segments = [];
  let tokens = [], word = '', quote = null, quoted = false, redirect = false;
  const flush = () => {
    if (word || quoted) tokens.push({ value: word, quoted });
    word = ''; quoted = false;
  };
  const split = () => { flush(); if (tokens.length) segments.push(tokens); tokens = []; };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) {
        if (text[i + 1] === quote) { word += c; i += 1; }
        else quote = null;
      } else if ((c === '`' || c === '\\') && text[i + 1] === quote && quote !== "'") {
        word += text[++i];
      } else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; quoted = true; continue; }
    if (c === '`' && i + 1 < text.length) { word += text[++i]; continue; }
    if (c === '#' && !word) {
      while (i < text.length && text[i] !== '\n') i += 1;
      split(); continue;
    }
    if (c === '>' || c === '<') {
      // Descriptor duplication (2>&1) is redirection, but does not write a file.
      redirect = true;
      const duplicate = /^>&[0-9-]+/.exec(text.slice(i));
      if (duplicate) { flush(); i += duplicate[0].length - 1; continue; }
      flush(); tokens.push({ value: c, redirect: true }); continue;
    }
    if (';|&\n\r'.includes(c)) { split(); continue; }
    if (/\s/.test(c)) { flush(); continue; }
    word += c;
  }
  split();
  return { segments, redirect };
}

function segmentKind(tokens, depth) {
  const [head, ...rest] = tokens;
  if (!head) return 'other';
  if (head.quoted) return 'other';
  // Only executable basenames in command position are normalized; paths in arguments
  // never enter command-word matching.
  const executable = /(?:^|[/\\])([^/\\]+)\.exe$/i.exec(head.value);
  const name = (executable ? executable[1] : head.value).toLowerCase();
  if (/[\\/]/.test(name) || /\w\.\w/.test(name)) return 'other';
  const args = rest.map((token) => token.value);
  if (DELETE_COMMAND.test(name)) return 'delete';
  if (WRITE_COMMAND.test(name)) return 'write';
  if (depth < 4 && /^(?:cmd|powershell|pwsh|bash|sh|zsh)$/.test(name)) {
    const index = args.findIndex((arg) => /^(?:\/c|-c|-command)$/i.test(arg));
    if (index >= 0) return classifyShellCommand(args.slice(index + 1).join(' '), depth + 1).kind;
  }
  if (/^(?:node|python|python3)$/.test(name)) {
    const index = args.findIndex((arg) => /^(?:-e|--eval|-c)$/.test(arg));
    const code = index >= 0 ? args[index + 1] || '' : '';
    if (DELETE_CODE.test(code)) return 'delete';
    if (WRITE_CODE.test(code)) return 'write';
  }
  if (name === 'git') {
    let i = 0;
    while (i < args.length && /^-/.test(args[i])) {
      i += /^(?:-C|-c|--git-dir|--work-tree)$/.test(args[i]) ? 2 : 1;
    }
    const sub = args[i];
    const flags = args.slice(i + 1);
    if (flags.some((flag) => /^--output(?:=|$)/.test(flag))) return 'write';
    if (sub === 'clean' || (sub === 'reset' && flags.includes('--hard'))
      || (sub === 'checkout' && flags.includes('--'))) return 'delete';
    if (/^(?:add|commit|push|merge|rebase|switch|checkout|reset|tag|stash|restore)$/.test(sub)) return 'write';
    if (/^(?:status|diff|log|show|rev-parse)$/.test(sub)) return 'read';
  }
  if (/^(?:npm|pnpm|yarn|pip)$/.test(name)
    && /^(?:install|add|remove|uninstall|publish)$/.test(args[0])) return 'write';
  if (name === 'sed' && args.some((arg) => /^-i|^--in-place/.test(arg))) return 'write';
  if (/^(?:node|npm|python|python3)$/.test(name) && args.length === 1 && args[0] === '--version') return 'read';
  if (READ_COMMAND.test(name)) return 'read';
  return 'other';
}

// Unknown commands remain fail-open; this classifier is not a security boundary.
function classifyShellCommand(command, depth = 0) {
  const { segments, redirect } = shellSegments(String(command == null ? '' : command));
  const kinds = segments.map((segment) => segmentKind(segment, depth));
  if (!redirect && kinds.length && kinds.every((kind) => kind === 'read')) return { mutating: false, kind: 'read' };
  if (kinds.includes('delete')) return { mutating: true, kind: 'delete' };
  const writesFile = segments.some((segment) => segment.some((token) => token.redirect && token.value === '>'));
  if (kinds.includes('write') || writesFile) return { mutating: true, kind: 'write' };
  return { mutating: false, kind: 'other' };
}

function classifyTool(toolName, toolInput) {
  const name = String(toolName == null ? '' : toolName).trim();
  const text = inputText(toolInput);

  if (FILE_TOOL.test(name)) {
    return { mutating: true, kind: DELETE_PATCH.test(text) ? 'delete' : 'write' };
  }

  if (SHELL_TOOL.test(name)) return classifyShellCommand(text);

  if (SANDBOX_TOOL.test(name)) {
    const nested = [];
    if (/\b(?:exec_command|shell_command|run_command|bash)\s*\(/i.test(text)) {
      // Literal code-mode command arguments use the same shell classifier. Dynamic
      // expressions remain unknown; never evaluate model-supplied JavaScript here.
      const fields = /\b(?:cmd|command)["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
      for (const match of text.matchAll(fields)) {
        try {
          const literal = match[1];
          const command = literal[0] === '"' ? JSON.parse(literal)
            : literal.slice(1, -1).replace(/\\(['\\])/g, '$1');
          nested.push(classifyShellCommand(command).kind);
        } catch {
          // An incomplete literal is not enough evidence to classify.
        }
      }
    }
    if (DELETE_CODE.test(text) || nested.includes('delete')) return { mutating: true, kind: 'delete' };
    if (WRITE_CODE.test(text) || nested.includes('write')) return { mutating: true, kind: 'write' };
    return { mutating: false, kind: 'other' };
  }

  return { mutating: false, kind: 'other' };
}

module.exports = { classifyShellCommand, classifyTool, inputText };
