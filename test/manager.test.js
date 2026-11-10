'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { SessionManager, STORAGE_KEY } = require('../src/manager');
const extensionManifest = require('../package.json');

function setup(initial = []) {
  const data = { [STORAGE_KEY]: initial };
  const terminals = [];
  const vscode = {
    workspace: { isTrusted: true, getConfiguration: () => ({ get: () => undefined }) },
    window: { terminals, createTerminal(options) {
      const terminal = { name: options.name, creationOptions: options, sendText(command) { this.sent = command; }, show(preserveFocus) { this.shownWith = preserveFocus; vscode.window.activeTerminal = this; }, dispose() { this.disposed = true; } };
      terminals.push(terminal);
      return terminal;
    } },
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }) },
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

test('adding an already tracked conversation updates its name and keeps its ID', async () => {
  const { manager, data } = setup();
  const first = await manager.add(session('same'), 'Old name');
  const duplicate = await manager.add(session('same'), 'New name');
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.name, 'New name');
  assert.equal(manager.entries.length, 1);
  assert.equal(data[STORAGE_KEY][0].name, 'New name');
  const terminal = { name:'Codex · same' };
  manager.observe(session('same'),terminal,first.id);
  assert.equal(first.name,'New name','automatic observation preserves an explicit name');
  const restarted = new SessionManager(manager.vscode,manager.context,()=>{},()=>{});
  assert.equal(restarted.entries[0].name,'New name','the custom name survives persistence');
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

test('disabled sessions remain in history and are not restored after restart', async () => {
  const { manager, terminals, context, vscode } = setup();
  const a = await manager.add(session('a'), 'A');
  const b = await manager.add(session('b'), 'B');
  await manager.setEnabled(a.id, false);
  const restarted = new SessionManager(vscode, context, () => {}, () => {});
  await restarted.restore();
  assert.equal(restarted.entries.length, 2);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].creationOptions.env.AGENT_SESSION_RESTORE_ID, b.id);
  await restarted.open(restarted.entries.find(entry => entry.id === a.id));
  assert.equal(restarted.entries.find(entry => entry.id === a.id).enabled, false, 'opening history once does not enable auto restore');
});

test('observing a paused running agent cannot silently re-enable restoration', async () => {
  const { manager } = setup();
  const entry = await manager.add(session('a'), 'A');
  const terminal = await manager.open(entry);
  await manager.setEnabled(entry.id, false);
  manager.observe(session('a'), terminal, entry.id);
  assert.equal(entry.enabled, false);
  assert.equal(terminal.disposed, undefined);
});

test('switching conversations archives the old session instead of overwriting it', async () => {
  const { manager } = setup();
  const a = await manager.add(session('a'), 'A');
  const terminal = await manager.open(a);
  terminal.name = 'New conversation';
  const observed = manager.observe(session('b'), terminal, a.id);
  assert.equal(a.enabled, false);
  assert.equal(a.sessionId, 'a');
  assert.equal(observed.entry.sessionId, 'b');
  assert.equal(observed.entry.enabled, true);
  assert.equal(manager.live.has(a.id), false);
  assert.equal(manager.entries.length, 2);
});

test('restoration reads per-agent arguments from VS Code settings', async () => {
  const { manager, vscode } = setup();
  const config = { codexArguments: ['--yolo'], agyArguments: ['--dangerously-skip-permissions'] };
  vscode.workspace.getConfiguration = () => ({ get: key => config[key] });
  await manager.add(session('exact-codex'), 'Codex');
  await manager.add({ provider: 'agy', sessionId: 'exact-agy', cwd: os.tmpdir() }, 'AGY');
  await manager.restore();
  assert.deepEqual(vscode.window.terminals.map(item => item.sent), [
    "'codex' '--yolo' 'resume' 'exact-codex'",
    "'agy' '--dangerously-skip-permissions' '--conversation' 'exact-agy'"
  ]);
});

test('Marketplace Claude defaults reach new and restored sessions; explicit empty override removes them', async () => {
  const marketDefault = extensionManifest.contributes.configuration.properties['agentSessionRestore.claudeArguments'].default;
  assert.deepEqual(marketDefault, ['--permission-mode', 'bypassPermissions']);
  const makeConfig = overrides => ({ get: key => Object.hasOwn(overrides, key)
    ? overrides[key]
    : extensionManifest.contributes.configuration.properties[`agentSessionRestore.${key}`]?.default });

  const standard = setup();
  let overrides = {};
  standard.vscode.workspace.getConfiguration = () => makeConfig(overrides);
  await standard.manager.add({ provider: 'claude', sessionId: 'claude-default-id', cwd: os.tmpdir() }, 'Claude default');
  await standard.manager.restore();
  assert.equal(standard.terminals[0].sent, "'claude' '--permission-mode' 'bypassPermissions' '--resume' 'claude-default-id'");
  const created = await standard.manager.create({ provider: 'claude', cwd: os.tmpdir() }, 'Claude new');
  assert.equal(created.sent, "'claude' '--permission-mode' 'bypassPermissions'");

  const cleared = setup();
  overrides = { claudeArguments: [] };
  cleared.vscode.workspace.getConfiguration = () => makeConfig(overrides);
  await cleared.manager.add({ provider: 'claude', sessionId: 'claude-cleared-id', cwd: os.tmpdir() }, 'Claude cleared');
  await cleared.manager.restore();
  assert.equal(cleared.terminals[0].sent, "'claude' '--resume' 'claude-cleared-id'");
  const withoutPermissionMode = await cleared.manager.create({ provider: 'claude', cwd: os.tmpdir() }, 'Claude cleared new');
  assert.equal(withoutPermissionMode.sent, "'claude'");
});

test('a newly named conversation starts fresh with configured arguments, then binds its actual ID', async () => {
  const {manager,vscode,terminals,data}=setup();
  await manager.add(session('old-id'),'测试？？？');
  vscode.workspace.getConfiguration=()=>({get:key=>key==='codexArguments'?['--yolo']:undefined});
  const terminal=await manager.create({provider:'codex',cwd:os.tmpdir()},'测试');
  assert.equal(terminal.sent,"'codex' '--yolo'");
  assert.equal(terminal.name,'测试');
  assert.equal(manager.entries.length,1,'no fake resume ID is persisted before the CLI saves a conversation');
  const pendingId=terminal.creationOptions.env.AGENT_SESSION_RESTORE_ID;
  assert.equal(manager.pending.has(pendingId),true);
  const observed=manager.observe(session('new-exact-id'),terminal,pendingId);
  await manager.save();
  assert.equal(observed.entry.id,pendingId);
  assert.equal(observed.entry.name,'测试');
  assert.equal(observed.entry.customName,true);
  assert.equal(JSON.stringify(manager.entries).includes('terminal'),false,'runtime terminal references never enter persisted records');
  terminal.name='Codex · 自动名称';
  manager.observe(session('new-exact-id'),terminal,pendingId);
  assert.equal(observed.entry.name,'测试','pending custom name remains stable after later observation');
  assert.equal(manager.pending.size,0);
  assert.deepEqual(data[STORAGE_KEY].map(entry=>entry.sessionId),['old-id','new-exact-id']);
  assert.equal(terminals.length,1);
});

test('new-session validation fails before creating terminals or pending entries', async () => {
  const {manager,vscode,terminals}=setup();
  vscode.workspace.getConfiguration=()=>({get:key=>key==='codexArguments'?'--yolo':undefined});
  await assert.rejects(manager.create({provider:'codex',cwd:os.tmpdir()},'New'),/array of single-line strings/);
  assert.equal(terminals.length,0);
  assert.equal(manager.pending.size,0);
});

test('per-session argument overrides persist and reach macOS fresh and exact-resume shell commands', async () => {
  const config = { claudeArguments: ['--permission-mode', 'bypassPermissions'] };
  const { manager, vscode, terminals, context } = setup();
  vscode.workspace.getConfiguration = () => ({ get: key => config[key] });
  const model = await manager.add({ provider:'claude', sessionId:'model-id', cwd:os.tmpdir() }, 'Model session');
  await manager.setSessionArguments(model.id, ['--model', 'claude-sonnet-4-5']);
  const empty = await manager.add({ provider:'claude', sessionId:'empty-id', cwd:os.tmpdir() }, 'No defaults');
  await manager.setSessionArguments(empty.id, []);
  await manager.restore();
  assert.equal(terminals[0].sent, "'claude' '--model' 'claude-sonnet-4-5' '--resume' 'model-id'");
  assert.equal(terminals[1].sent, "'claude' '--resume' 'empty-id'");
  const reloaded = new SessionManager(vscode, context, () => {}, () => {});
  assert.deepEqual(reloaded.entries.find(entry=>entry.id===model.id).sessionArguments,['--model','claude-sonnet-4-5']);
  assert.deepEqual(reloaded.entries.find(entry=>entry.id===empty.id).sessionArguments,[]);
  const fresh = await manager.create({provider:'claude',cwd:os.tmpdir(),sessionArguments:['--model','claude-haiku-4-5']},'Fresh override');
  assert.equal(fresh.sent,"'claude' '--model' 'claude-haiku-4-5'");
});

test('history hiding is reversible and preserves enabled, running, and favorite records', async () => {
  const {manager,data}=setup();
  const enabled=await manager.add(session('enabled'),'Enabled');
  const paused=await manager.add(session('paused'),'Paused',false);
  const favorite=await manager.add(session('favorite'),'Favorite',false);
  await manager.setFavorite(favorite.id,true);
  await manager.hideHistoryEntries([enabled,paused,favorite,session('native')]);
  assert.equal(manager.hiddenHistory.has('codex:enabled'),false);
  assert.equal(manager.hiddenHistory.has('codex:paused'),true);
  assert.equal(manager.hiddenHistory.has('codex:favorite'),false);
  assert.equal(manager.hiddenHistory.has('codex:native'),true);
  await manager.resetHiddenHistory();
  assert.deepEqual(data['rekindle.hiddenHistory.v1'],[]);
});

test('failed restore is shown and retry starts a fresh selected terminal', async () => {
  const {manager,vscode,terminals}=setup();
  const entry=await manager.add(session('retry-id'),'Retry me');
  const create=vscode.window.createTerminal;
  let first=true;
  vscode.window.createTerminal=options=>{
    const terminal=create(options);
    const send=terminal.sendText.bind(terminal);
    terminal.sendText=command=>{if(first){first=false;throw new Error('simulated shell send failure');}return send(command);}; const dispose=terminal.dispose.bind(terminal); terminal.dispose=()=>{dispose();terminal.exitStatus={code:1};};
    return terminal;
  };
  await assert.rejects(manager.open(entry),/simulated shell send failure/);
  assert.equal(manager.status.get(entry.id).state,'restore-failed');
  assert.equal(manager.live.has(entry.id),false,'failed new terminal is not left as an apparent live restore');
  assert.equal(terminals[0].disposed,true);
  await manager.open(entry);
  assert.equal(terminals.length,2);
  assert.equal(terminals[1].sent,"'codex' 'resume' 'retry-id'");
  assert.equal(manager.status.get(entry.id).state,'unknown','a successful retry waits for lifecycle identification');
});

test('explicitly opening an old tracked native row makes it visible without changing its task activity', async () => {
  const {manager}=setup();
  const old=await manager.add({...session('old-native'),updatedAt:Date.now()-20*86400000},'Old native',false);
  const oldActivity=old.lastActivityAt;
  await manager.open(old);
  assert.equal(old.lastActivityAt,oldActivity,'opening is stored separately from provider task activity');
  assert.ok(old.lastOpenedAt>Date.now()-10000);
});
