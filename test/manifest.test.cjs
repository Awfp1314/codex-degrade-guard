const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const packageManifest = require(path.join(root, 'package.json'));
const pluginManifest = require(path.join(root, '.codex-plugin', 'plugin.json'));

test('插件清单内嵌 Codex hooks，重启后仍能注册三条事件', () => {
  assert.equal(pluginManifest.version, packageManifest.version);
  assert.equal(typeof pluginManifest.hooks, 'object');
  assert.equal(typeof pluginManifest.hooks.hooks, 'object');
  assert.deepEqual(
    Object.keys(pluginManifest.hooks.hooks).sort(),
    ['PreToolUse', 'Stop', 'UserPromptSubmit'].sort()
  );
  assert.notEqual(pluginManifest.hooks, './hooks/hooks.json');

  for (const event of ['UserPromptSubmit', 'PreToolUse', 'Stop']) {
    const entries = pluginManifest.hooks.hooks[event];
    assert.ok(Array.isArray(entries) && entries.length > 0);
    const handler = entries[0].hooks[0];
    assert.equal(handler.type, 'command');
    assert.match(handler.command, /hooks[\\/]guard\.cjs/);
    assert.ok(handler.commandWindows.includes('hooks\\guard.cjs'));
  }

  assert.ok(fs.existsSync(path.join(root, 'hooks', 'guard.cjs')));
});
