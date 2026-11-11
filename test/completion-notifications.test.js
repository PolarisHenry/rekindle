'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  notificationsEnabled,
  completionNotificationLocation,
  notificationTargets,
  setNotificationsEnabled,
  setCompletionNotificationLocation,
  CompletionStatusBar,
  MAX_PENDING
} = require('../src/completion-notifications');
const manifest = require('../package.json');

function mockVscode({ enabled, location } = {}) {
  const values = { completionNotifications: enabled, completionNotificationLocation: location };
  const updates = [], contexts = [], statusItems = [];
  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    StatusBarAlignment: { Right: 2 },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/test' } }],
      getConfiguration: () => ({
        get: (key, fallback) => values[key] === undefined ? fallback : values[key],
        update: async (key, value, target) => { values[key] = value; updates.push({ key, value, target }); }
      })
    },
    commands: { executeCommand: async (...args) => { contexts.push(args); } },
    window: { createStatusBarItem: () => {
      const item = { hide() { this.hidden = true; }, show() { this.hidden = false; }, dispose() { this.disposed = true; } };
      statusItems.push(item);
      return item;
    } }
  };
  return { vscode, values, updates, contexts, statusItems };
}

test('Marketplace defaults to persistent status bar reminders and contributes location controls', () => {
  assert.equal(manifest.contributes.configuration.properties['agentSessionRestore.completionNotifications'].default, true);
  assert.equal(manifest.contributes.configuration.properties['agentSessionRestore.completionNotificationLocation'].default, 'statusBar');
  assert.deepEqual(manifest.contributes.configuration.properties['agentSessionRestore.completionNotificationLocation'].enum, ['statusBar', 'native', 'both']);
  assert.equal(manifest.contributes.configuration.properties['agentSessionRestore.sessionPulse'].default, true);
  const actions = manifest.contributes.menus['view/title'].map(item => item.command || item.submenu);
  assert.ok(actions.includes('rekindle.completionLocation'));
  assert.ok(actions.includes('agentSessionRestore.clearCompletionStatus'));
  assert.deepEqual(manifest.contributes.menus['rekindle.completionLocation'].map(item => item.command), [
    'agentSessionRestore.completionLocationStatusBar',
    'agentSessionRestore.completionLocationNative',
    'agentSessionRestore.completionLocationBoth'
  ]);
});

test('legacy notification boolean and location setting route independently', async () => {
  const { vscode, updates, contexts } = mockVscode();
  assert.equal(notificationsEnabled(vscode), true);
  assert.equal(completionNotificationLocation(vscode), 'statusBar');
  assert.deepEqual(notificationTargets(vscode), { statusBar: true, native: false });
  assert.equal(await setCompletionNotificationLocation(vscode, 'native'), 'native');
  assert.deepEqual(notificationTargets(vscode), { statusBar: false, native: true });
  assert.equal(await setCompletionNotificationLocation(vscode, 'both'), 'both');
  assert.deepEqual(notificationTargets(vscode), { statusBar: true, native: true });
  await setNotificationsEnabled(vscode, false);
  assert.deepEqual(notificationTargets(vscode), { statusBar: false, native: false });
  assert.deepEqual(updates.at(-1), { key: 'completionNotifications', value: false, target: vscode.ConfigurationTarget.Workspace });
  assert.ok(contexts.some(row => row[0] === 'setContext' && row[1] === 'rekindle.completionNotifications' && row[2] === false));
  assert.ok(contexts.some(row => row[0] === 'setContext' && row[1] === 'rekindle.completionNotificationLocation' && row[2] === 'both'));
  await assert.rejects(setCompletionNotificationLocation(vscode, 'elsewhere'), /Choose Status Bar/);
});

test('status bar queue merges turns per session, opens latest named session, bounds items, and acknowledges safely', async () => {
  const { vscode, statusItems } = mockVscode();
  const status = new CompletionStatusBar(vscode, 2);
  const item = statusItems[0];
  const a = { id: 'a', provider: 'agy', sessionId: 'a-id', name: '查问题', cwd: '/work/a' };
  assert.equal(status.add(a, 'a-turn-1'), true);
  assert.equal(status.add(a, 'a-turn-2'), true, 'a new completed turn updates the existing session reminder');
  assert.equal(status.getPending().length, 1);
  assert.equal(item.text, '$(check) AGY · 查问题');
  assert.equal(status.add({ id: 'b', provider: 'pi', sessionId: 'b-id', name: 'Pi', cwd: '/work/b' }, 'b-turn'), true);
  assert.match(item.text, /\+1$/);
  status.add({ id: 'c', provider: 'codex', sessionId: 'c-id', name: 'Codex', cwd: '/work/c' }, 'c-turn');
  assert.deepEqual(status.getPending().map(row => row.id), ['b', 'c'], 'the oldest sessions roll off at the queue limit');
  assert.equal(status.acknowledgeSession('b', 'pi', 'b-id'), true);
  assert.deepEqual(status.getPending().map(row => row.id), ['c']);
  status.setAvailable(false);
  assert.equal(item.hidden, true);
  assert.equal(status.getPending().length, 0, 'turning the route off immediately clears unread status items');
  status.setAvailable(true);
  status.add(a, 'a-turn-3');
  status.clear();
  assert.equal(item.hidden, true);
  status.dispose();
  assert.equal(item.disposed, true);
});
