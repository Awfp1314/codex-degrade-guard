'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyShellCommand, classifyTool } = require('../lib/tools.cjs');

test('文件类工具一律算写/删', () => {
  assert.equal(classifyTool('apply_patch', { patch: '*** Begin Patch' }).mutating, true);
  assert.equal(classifyTool('Edit', { file_path: 'a.ts' }).mutating, true);
  assert.equal(classifyTool('Write', { file_path: 'a.ts', content: 'x' }).mutating, true);
  assert.equal(classifyTool('fileChange', {}).mutating, true);
});

test('删除补丁标记为 delete', () => {
  const tool = classifyTool('apply_patch', { patch: '*** Begin Patch\n*** Delete File: a.txt\n*** End Patch' });
  assert.equal(tool.mutating, true);
  assert.equal(tool.kind, 'delete');
});

test('只读命令不拦', () => {
  assert.deepEqual(classifyShellCommand('Get-ChildItem -Force'), { mutating: false, kind: 'read' });
  assert.deepEqual(classifyShellCommand('rg "foo" src/'), { mutating: false, kind: 'read' });
  assert.deepEqual(classifyShellCommand('git diff HEAD --stat'), { mutating: false, kind: 'read' });
  assert.equal(classifyTool('Bash', { command: 'cat README.md' }).mutating, false);
});

test('会改文件的命令要拦', () => {
  assert.equal(classifyShellCommand("Write-Output 'hi' > out.txt").mutating, true);
  assert.equal(classifyShellCommand("Set-Content -Path a.txt -Value b").mutating, true);
  assert.equal(classifyShellCommand('npm install lodash').mutating, true);
  assert.equal(classifyShellCommand('git commit -m "x"').mutating, true);
});

test('删除命令要拦', () => {
  assert.equal(classifyShellCommand("Remove-Item -LiteralPath '.\\out.txt' -Force").kind, 'delete');
  assert.equal(classifyShellCommand('rm -rf build').mutating, true);
  assert.equal(classifyShellCommand('cmd /c del /f /q out.txt').kind, 'delete');
  assert.equal(classifyShellCommand("node -e \"require('fs').unlinkSync('a')\"").kind, 'delete');
});

test('重定向 2>&1 不算写', () => {
  assert.equal(classifyShellCommand('node build.js 2>&1').mutating, false);
});

test('代码沙箱只有出现写/删 API 才拦', () => {
  assert.equal(classifyTool('exec', { code: 'await tools.exec_command({command:"ls"})' }).mutating, false);
  assert.equal(classifyTool('exec', { code: 'await tools.apply_patch({patch:"..."})' }).mutating, true);
  assert.equal(classifyTool('exec', { code: 'fs.writeFileSync("a", "b")' }).mutating, true);
});

test('未知工具不拦（只拦文档里点名的写/删路径）', () => {
  assert.equal(classifyTool('update_plan', { plan: [] }).mutating, false);
  assert.equal(classifyTool('Read', { file_path: 'a.ts' }).mutating, false);
  assert.equal(classifyTool('', {}).mutating, false);
});
