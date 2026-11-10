'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activate: activateBridge } = require('../src/migration-bridge');
const {
  OLD_EXTENSION_ID, STORAGE_KEY, MIGRATION_MARKER, MIGRATION_PENDING,
  workspaceFingerprint, importLegacySnapshot
} = require('../src/migration');

function memento(seed = {}) {
  const values = { ...seed };
  return {
    values,
    get(key, fallback) { return values[key] === undefined ? fallback : values[key]; },
    async update(key, value) { if (value === undefined) delete values[key]; else values[key] = value; }
  };
}

function fixture({ oldSeed = {}, newSeed = {}, oldVersion = '0.8.5', workspaceOverride, oldWorkspace } = {}) {
  const workspace = workspaceOverride || {
    workspaceFile: undefined,
    workspaceFolders: [{ uri: { toString: () => 'file:///tmp/rekindle-workspace' } }]
  };
  const oldState = memento(oldSeed);
  const newState = memento(newSeed);
  const oldContext = { workspaceState: oldState };
  const api = activateBridge(oldContext, { workspace: oldWorkspace || workspace });
  let activateCount = 0;
  const vscode = {
    workspace,
    extensions: { getExtension(id) {
      assert.equal(id, OLD_EXTENSION_ID);
      return { packageJSON: { version: oldVersion }, activate: async () => { activateCount++; return api; } };
    } }
  };
  const context = { workspaceState: newState };
  return { workspace, oldState, newState, context, vscode, api, activated: () => activateCount };
}

test('passive legacy API exports only whitelisted session metadata and view preferences', () => {
  const terminal = { shellPid: 123, sendText() {} };
  const entry = { id: 'stable-id', provider: 'codex', sessionId: 'session-id', cwd: '/work', name: 'Renamed', customName: true, enabled: false, archived: true, favorite: true, lastActivityAt: 1234, lastOpenedAt: 5678, sessionArguments: ['--model', 'o3'], createdAt: 'date', terminal, prompt: 'never export', credential: 'secret' };
  const fx = fixture({ oldSeed: {
    [STORAGE_KEY]: [entry],
    'rekindle.showHistory': true,
    'rekindle.groupBy': 'agent',
    'rekindle.workspaceOnly': false
  } });
  assert.equal(fx.api.passive, true);
  const snapshot = fx.api.getMigrationSnapshot();
  assert.equal(snapshot.sessions[0].id, 'stable-id');
  assert.equal(snapshot.sessions[0].enabled, false);
  assert.equal(snapshot.sessions[0].customName, true);
  assert.equal(snapshot.sessions[0].favorite, true);
  assert.equal(snapshot.sessions[0].lastActivityAt, 1234);
  assert.deepEqual(snapshot.sessions[0].sessionArguments, ['--model', 'o3']);
  assert.equal('terminal' in snapshot.sessions[0], false);
  assert.equal('prompt' in snapshot.sessions[0], false);
  assert.equal('credential' in snapshot.sessions[0], false);
  assert.deepEqual(snapshot.preferences, {
    'rekindle.showHistory': true, 'rekindle.groupBy': 'agent', 'rekindle.workspaceOnly': false
  });
});

test('migration accepts only a string-array session override and ignores runtime objects', () => {
  const fx=fixture({oldSeed:{[STORAGE_KEY]:[
    {id:'safe',provider:'pi',sessionId:'safe-id',cwd:'/work',name:'Safe',sessionArguments:['--model','x'],lastOpenedAt:123,terminal:{runtime:true}},
    {id:'bad',provider:'pi',sessionId:'bad-id',cwd:'/work',name:'Bad',sessionArguments:['--model',{}]}
  ]}});
  const rows=fx.api.getMigrationSnapshot().sessions;
  assert.deepEqual(rows.find(entry=>entry.id==='safe').sessionArguments,['--model','x']);
  assert.equal(rows.find(entry=>entry.id==='safe').lastOpenedAt,123);
  assert.equal(rows.find(entry=>entry.id==='bad').sessionArguments,undefined);
  assert.equal(rows.some(entry=>'terminal' in entry),false);
});

test('new identity imports matching workspace once, preserving disabled flags and preferences', async () => {
  const fx = fixture({ oldSeed: {
    [STORAGE_KEY]: [{ id: 'kept-id', provider: 'pi', sessionId: 'pi-id', sessionFile: '/tmp/pi-session', cwd: '/work', name: 'Custom', customName: true, enabled: false, archived: true }],
    'rekindle.showHistory': true,
    'rekindle.groupBy': 'agent',
    'rekindle.workspaceOnly': false
  } });
  const first = await importLegacySnapshot(fx);
  assert.equal(first.status, 'imported');
  assert.deepEqual(fx.newState.get(STORAGE_KEY), fx.api.getMigrationSnapshot().sessions);
  assert.equal(fx.newState.get(STORAGE_KEY)[0].id, 'kept-id');
  assert.equal(fx.newState.get(STORAGE_KEY)[0].enabled, false);
  assert.equal(fx.newState.get('rekindle.groupBy'), 'agent');
  assert.equal(fx.newState.get('rekindle.showHistory'), true);
  assert.equal(fx.newState.get('rekindle.workspaceOnly'), false);
  assert.equal(fx.newState.get(MIGRATION_MARKER).status, 'imported');
  assert.equal(fx.newState.get(MIGRATION_PENDING), undefined);
  assert.equal((await importLegacySnapshot(fx)).status, 'already-imported');
  assert.equal(fx.activated(), 1);
});

test('existing new-identity records are never overwritten by legacy records', async () => {
  const fx = fixture({
    oldSeed: { [STORAGE_KEY]: [{ id: 'legacy', provider: 'codex', sessionId: 'old', cwd: '/work', name: 'Legacy' }] },
    newSeed: { [STORAGE_KEY]: [{ id: 'new', provider: 'pi', sessionId: 'new', cwd: '/work', name: 'New' }] }
  });
  assert.equal((await importLegacySnapshot(fx)).status, 'skipped-existing-data');
  assert.equal(fx.newState.get(STORAGE_KEY)[0].id, 'new');
  assert.equal(fx.newState.get(MIGRATION_MARKER).status, 'skipped-existing-data');
});

test('workspace mismatch and pre-bridge installations block safely without activation', async () => {
  const changedWorkspace = {
    workspaceFile: undefined,
    workspaceFolders: [{ uri: { toString: () => 'file:///tmp/other-workspace' } }]
  };
  const oldWorkspace = {
    workspaceFile: undefined,
    workspaceFolders: [{ uri: { toString: () => 'file:///tmp/original-workspace' } }]
  };
  const mismatch = fixture({ workspaceOverride: changedWorkspace, oldWorkspace });
  assert.equal((await importLegacySnapshot(mismatch)).status, 'blocked-workspace-mismatch');
  assert.equal(mismatch.activated(), 1, 'bridge API is needed to read and validate its workspace fingerprint');

  const old = fixture({ oldVersion: '0.8.4' });
  assert.equal((await importLegacySnapshot(old)).status, 'blocked-old-version');
  assert.equal(old.activated(), 0);
});

test('interrupted imports recover idempotently without replacing records added later', async () => {
  const fx = fixture({ oldSeed: { [STORAGE_KEY]: [
    { id: 'legacy', provider: 'codex', sessionId: 'old', cwd: '/work', name: 'Legacy' }
  ] } });
  const fingerprint = workspaceFingerprint(fx.workspace);
  const snapshot = fx.api.getMigrationSnapshot();
  await fx.newState.update(MIGRATION_PENDING, { fingerprint, snapshot });
  await fx.newState.update(STORAGE_KEY, [{ id: 'legacy', provider: 'codex', sessionId: 'old', cwd: '/work', name: 'Legacy' }]);
  await fx.newState.update(STORAGE_KEY, [{ id: 'legacy', provider: 'codex', sessionId: 'old', cwd: '/work', name: 'Legacy' }, { id: 'new', provider: 'pi', sessionId: 'new', cwd: '/work', name: 'New' }]);
  assert.equal((await importLegacySnapshot(fx)).status, 'recovered-import');
  assert.deepEqual(fx.newState.get(STORAGE_KEY).map(entry => entry.id), ['legacy', 'new']);
  assert.equal(fx.newState.get(MIGRATION_PENDING), undefined);
  assert.equal((await importLegacySnapshot(fx)).status, 'already-imported');
});

test('partial import retries after a preference write failure and commits marker last', async () => {
  const fx = fixture({ oldSeed: {
    [STORAGE_KEY]: [{ id: 'legacy', provider: 'codex', sessionId: 'old', cwd: '/work', name: 'Legacy', enabled: false }],
    'rekindle.showHistory': true,
    'rekindle.groupBy': 'agent'
  } });
  const originalUpdate = fx.newState.update.bind(fx.newState);
  let failOnce = true;
  fx.newState.update = async (key, value) => {
    if (key === 'rekindle.groupBy' && failOnce) { failOnce = false; throw new Error('simulated interrupted preference write'); }
    return originalUpdate(key, value);
  };
  await assert.rejects(importLegacySnapshot(fx), /simulated interrupted/);
  assert.equal(fx.newState.get(STORAGE_KEY)[0].id, 'legacy', 'entries were persisted before the interrupted preference write');
  assert.equal(fx.newState.get(MIGRATION_MARKER), undefined, 'marker is written only after all fields');
  assert.ok(fx.newState.get(MIGRATION_PENDING), 'pending snapshot remains for recovery');
  assert.equal((await importLegacySnapshot(fx)).status, 'recovered-import');
  assert.equal(fx.newState.get('rekindle.groupBy'), 'agent');
  assert.equal(fx.newState.get(MIGRATION_MARKER).status, 'imported');
  assert.equal(fx.newState.get(MIGRATION_PENDING), undefined);
  assert.equal(fx.newState.get(STORAGE_KEY).length, 1);
});
