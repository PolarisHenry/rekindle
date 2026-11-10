'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { notificationsEnabled, setNotificationsEnabled } = require('../src/completion-notifications');
const manifest = require('../package.json');

test('Marketplace enables completion notifications by default and exposes both view-menu actions', () => {
  assert.equal(manifest.contributes.configuration.properties['agentSessionRestore.completionNotifications'].default, true);
  const actions = manifest.contributes.menus['view/title'].map(item => item.command);
  assert.ok(actions.includes('agentSessionRestore.enableCompletionNotifications'));
  assert.ok(actions.includes('agentSessionRestore.disableCompletionNotifications'));
});

test('completion notification setting defaults on and explicit toggles update user configuration/context', async () => {
  let configured;
  const updates = [], contexts = [];
  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    workspace: { workspaceFolders: [{ uri: { fsPath: '/test' } }], getConfiguration: () => ({
      get: (_key, fallback) => configured === undefined ? fallback : configured,
      update: async (key, value, target) => { configured = value; updates.push({ key, value, target }); }
    }) },
    commands: { executeCommand: async (...args) => contexts.push(args) }
  };
  assert.equal(notificationsEnabled(vscode), true);
  assert.equal(await setNotificationsEnabled(vscode, false), false);
  assert.equal(notificationsEnabled(vscode), false);
  assert.deepEqual(updates[0], { key: 'completionNotifications', value: false, target: vscode.ConfigurationTarget.Workspace });
  assert.deepEqual(contexts[0], ['setContext', 'rekindle.completionNotifications', false]);
  await setNotificationsEnabled(vscode, true);
  assert.equal(notificationsEnabled(vscode), true);
});
