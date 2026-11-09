'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAgentTerminal, ShellGate } = require('../src/python-terminal');

test('the selected Python environment finishes activation before its terminal is returned', async () => {
  let activated = false;
  let environmentScope;
  const terminal = { creationOptions: {} };
  const vscode = {
    Uri: { file: path => path }, extensions: { getExtension: () => ({}) },
    workspace: { getConfiguration: () => ({ get: () => true }) },
    window: { terminals: [], createTerminal: () => { throw new Error('ordinary terminal should not be created'); } }
  };
  const api = { getEnvironment: async scope => { environmentScope = scope; return { id: 'selected-env' }; }, createTerminal: async () => { await new Promise(resolve => setTimeout(resolve, 10)); activated = true; return terminal; } };
  const result = await createAgentTerminal(vscode, { cwd: '/project', env: {} }, () => {}, async () => api);
  assert.equal(activated, true);
  assert.equal(result, terminal);
  assert.equal(environmentScope, '/project');
});

test('the shell gate waits for a delayed source activation command to finish', async () => {
  let start, end;
  const terminal = {};
  const vscode = { window: { terminals: [terminal], onDidStartTerminalShellExecution: callback => { start = callback; return { dispose() {} }; }, onDidEndTerminalShellExecution: callback => { end = callback; return { dispose() {} }; } } };
  const gate = new ShellGate(vscode);
  const execution = {};
  let finished = false;
  setTimeout(() => start({ terminal, execution }), 10);
  setTimeout(() => { finished = true; end({ terminal, execution }); }, 70);
  await gate.wait(terminal, { grace: 30, quiet: 10 });
  assert.equal(finished, true);
  gate.dispose();
});
