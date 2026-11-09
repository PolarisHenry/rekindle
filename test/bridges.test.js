'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { installAgentBridges } = require('../src/bridges');
const { normalize, owningProcess } = require('../src/session-hook.cjs');
const { resumeArguments } = require('../src/core');
const { unusedShell, removeStartupShells } = require('../src/startup');

test('Claude and AGY restore exact conversations with provider-specific flags', () => {
  assert.deepEqual(resumeArguments({ provider: 'claude', sessionId: 'claude-id' }), ['--resume', 'claude-id']);
  assert.deepEqual(resumeArguments({ provider: 'agy', sessionId: 'agy-id' }), ['--conversation', 'agy-id']);
});

test('provider hook payloads retain only session metadata, not prompts or tool inputs', () => {
  const claude = normalize('claude', { session_id: 'a', cwd: '/workspace', transcript_path: '/a.jsonl', prompt: 'private input', tool_input: {} });
  const agy = normalize('agy', { conversationId: 'b', workspacePaths: ['/workspace'], transcriptPath: '/b.jsonl', lastUserInput: 'private input' });
  assert.deepEqual(claude, { provider: 'claude', sessionId: 'a', cwd: '/workspace', sessionFile: '/a.jsonl' });
  assert.equal(agy.sessionId, 'b');
  assert.equal('lastUserInput' in agy, false);
  assert.equal(normalize('claude', { session_id: 'sub', cwd: '/workspace', agent_id: 'nested' }), null);
});

test('hook process ancestry cannot associate another terminal with a session', () => {
  const processes = '1 0 init\n10 1 /bin/zsh\n11 10 /bin/claude\n12 11 /bin/sh\n20 1 /bin/agy\n21 20 /bin/sh';
  assert.equal(owningProcess(12, processes, 'claude'), 11);
  assert.equal(owningProcess(21, processes, 'agy'), 20);
  assert.equal(owningProcess(12, processes, 'agy'), null);
});

test('bridge installation preserves existing hooks and stays idempotent', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-hooks-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ model: 'keep-me', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } }));
  await installAgentBridges(home);
  await installAgentBridges(home);
  const claude = JSON.parse(await fs.readFile(path.join(home, '.claude/settings.json')));
  assert.equal(claude.model, 'keep-me');
  assert.equal(claude.hooks.SessionStart.length, 2);
  assert.equal(claude.hooks.SessionStart[0].hooks[0].command, 'echo existing');
  const agy = JSON.parse(await fs.readFile(path.join(home, '.gemini/config/hooks.json')));
  assert.ok(agy.rekindle.SessionStart[0].command.endsWith(' agy'));
});

test('only an untouched default shell is eligible for startup cleanup', () => {
  const shell = { name: 'zsh', state: { isInteractedWith: false }, creationOptions: {} };
  assert.equal(unusedShell(shell), true);
  assert.equal(unusedShell({ ...shell, state: { isInteractedWith: true } }), false);
  assert.equal(unusedShell({ ...shell, name: 'My shell' }), false);
  assert.equal(unusedShell({ ...shell, creationOptions: { env: { AGENT_SESSION_RESTORE_ID: 'keep' } } }), false);
});

test('no restored agent means default shell is retained', async () => {
  let disposed = false;
  const shell = { dispose() { disposed = true; } };
  await removeStartupShells({}, { entries: [], live: new Map() }, [shell], () => {});
  assert.equal(disposed, false);
});
