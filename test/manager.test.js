'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { SessionManager, STORAGE_KEY } = require('../src/manager');

function setup(initial = []) {
  const data = { [STORAGE_KEY]: initial };
  const terminals = [];
  const vscode = {
    workspace: { isTrusted: true, getConfiguration: () => ({ get: () => undefined }) },
    window: { terminals, createTerminal(options) {
      const terminal = { creationOptions: options, sendText(command) { this.sent = command; }, show(preserveFocus) { this.shownWith = preserveFocus; vscode.window.activeTerminal = this; }, dispose() { this.disposed = true; } };
      terminals.push(terminal);
      return terminal;
    } },
    ThemeIcon: class {}
  };
  const context = { workspaceState: { get: (key, fallback) => data[key] ?? fallback, update: async (key, value) => { data[key] = value; } } };
  const manager = new SessionManager(vscode, context, () => {}, () => {});
  return { manager, vscode, context, terminals, data };
}

const session = id => ({ provider: 'codex', sessionId: id, cwd: os.tmpdir() });

test('concurrent restore does not create duplicate terminals; each ID is distinct', async () => {
  const { manager, terminals } = setup();
  const a = await manager.add(session('a'), 'A');
  const b = await manager.add(session('b'), 'B');
  await Promise.all([manager.open(a), manager.open(a), manager.restore(), manager.open(b)]);
  assert.equal(terminals.length, 2);
  assert.notEqual(terminals[0].creationOptions.env.AGENT_SESSION_RESTORE_ID, terminals[1].creationOptions.env.AGENT_SESSION_RESTORE_ID);
});

test('terminal closure during shutdown does not erase the saved conversation', async () => {
  const { manager, terminals, data, context, vscode } = setup();
  const entry = await manager.add(session('a'), 'A');
  const terminal = await manager.open(entry);
  terminals.splice(0);
  manager.closed(terminal);
  const restarted = new SessionManager(vscode, context, () => {}, () => {});
  await restarted.restore();
  assert.equal(data[STORAGE_KEY][0].sessionId, 'a');
  assert.equal(terminals.length, 1);
});

test('forgetting a mapping does not terminate agents or erase other mappings', async () => {
  const { manager, terminals, data } = setup();
  const a = await manager.add(session('a'), 'A');
  await manager.add(session('b'), 'B');
  await manager.open(a);
  await manager.remove(a.id);
  assert.equal(terminals[0].disposed, undefined);
  assert.deepEqual(data[STORAGE_KEY].map(item => item.sessionId), ['b']);
});

test('untrusted workspace does not launch a command', async () => {
  const { manager, terminals, vscode } = setup();
  const entry = await manager.add(session('a'), 'A');
  vscode.workspace.isTrusted = false;
  await assert.rejects(manager.open(entry), /Trust/);
  assert.equal(terminals.length, 0);
});

test('missing cwd is reported and does not silently start a different session', async () => {
  const { manager, terminals } = setup();
  await manager.add({ ...session('a'), cwd: '/nonexistent-agent-session-fixture' }, 'A');
  const failures = await manager.restore();
  assert.equal(failures.length, 1);
  assert.equal(terminals.length, 0);
});

test('restore focuses the first successful agent, never creates a default shell', async () => {
  const { manager, terminals, vscode } = setup();
  await manager.add({ ...session('missing'), cwd: '/nonexistent-agent-session-fixture' }, 'Missing');
  const first = await manager.add(session('first'), 'First agent');
  await manager.add(session('second'), 'Second agent');
  await manager.restore();
  assert.equal(terminals.length, 2);
  assert.equal(vscode.window.activeTerminal, manager.live.get(first.id));
  assert.equal(vscode.window.activeTerminal.shownWith, false, 'keyboard focus moves into the agent');
  await manager.restore();
  assert.equal(terminals.length, 2);
});
