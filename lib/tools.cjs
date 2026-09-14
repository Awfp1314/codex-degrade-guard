'use strict';

// 判断一次工具调用是否会写/删文件。只拦写/删，读和搜索一律放行。

const FILE_TOOL = /^(apply_patch|edit|write|multiedit|multi_edit|notebookedit|notebook_edit|file[_-]?change|create[_-]?file|write[_-]?file|str[_-]?replace[_-]?editor|delete[_-]?file|remove[_-]?file|move[_-]?file|rename[_-]?file|patch)$/i;
const SHELL_TOOL = /^(bash|exec[_-]?command|shell[_-]?command|shell|local[_-]?shell|run[_-]?command|run[_-]?shell|terminal|powershell|cmd|zsh)$/i;
const SANDBOX_TOOL = /^(exec|js|javascript|node|code[_-]?mode|sandbox|python|python3)$/i;

const DELETE_COMMAND = /\b(?:rm|del|erase|rmdir|rd|Remove-Item|Clear-Content|shutil\.rmtree|os\.remove|os\.unlink|unlink|unlinkSync|fs\.unlink|fs\.rm|git\s+clean|git\s+reset\s+--hard|git\s+checkout\s+--)\b/i;
const WRITE_COMMAND = /\b(?:Set-Content|Add-Content|Out-File|New-Item|Move-Item|Copy-Item|Rename-Item|tee|touch|mkdir|truncate|dd|sed\s+-i|apply_patch|patch|git\s+(?:add|commit|push|merge|rebase|switch|checkout|reset|tag|stash)|npm\s+(?:install|add|remove|uninstall|publish)|pnpm\s+(?:install|add|remove|uninstall|publish)|yarn\s+(?:install|add|remove|publish)|pip\s+install|writeFile|writeFileSync|appendFile|createWriteStream|fs\.write)\b/i;
const REDIRECT = /(^|[^<0-9])>{1,2}\s*[^&\s=]/;
const READ_COMMAND = /\b(?:Get-Content|Get-ChildItem|Get-Item|Test-Path|Resolve-Path|Select-String|Measure-Object|Compare-Object|Where-Object|ForEach-Object|rg|grep|findstr|cat|ls|dir|pwd|head|tail|wc|type|git\s+(?:status|diff|log|show|rev-parse|branch)|node\s+--version|python\s+--version)\b/i;

const DELETE_PATCH = /^\*\*\*\s*Delete File:/m;

function inputText(toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  if (!toolInput || typeof toolInput !== 'object') return '';
  const parts = [];
  for (const key of ['command', 'patch', 'file_text', 'content', 'new_string', 'new_str', 'code', 'script', 'input']) {
    const value = toolInput[key];
    if (typeof value === 'string' && value) parts.push(value);
  }
  return parts.join('\n');
}

// shell 命令：有写/删特征就算写，纯读命令放行，判不准的按「不是写」处理。
function classifyShellCommand(command) {
  const text = String(command == null ? '' : command).trim();
  if (!text) return { mutating: false, kind: 'other' };
  if (DELETE_COMMAND.test(text)) return { mutating: true, kind: 'delete' };
  if (WRITE_COMMAND.test(text) || REDIRECT.test(text)) return { mutating: true, kind: 'write' };
  if (READ_COMMAND.test(text)) return { mutating: false, kind: 'read' };
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
    // 代码沙箱：出现明确的写/删 API 才拦。
    if (DELETE_COMMAND.test(text)) return { mutating: true, kind: 'delete' };
    if (WRITE_COMMAND.test(text)) return { mutating: true, kind: 'write' };
    return { mutating: false, kind: 'other' };
  }

  return { mutating: false, kind: 'other' };
}

module.exports = { classifyShellCommand, classifyTool, inputText };
