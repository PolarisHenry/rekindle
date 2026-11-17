'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeLocale, setLocale, getLocale, retranslate, t } = require('../src/localization');
const { SessionTree } = require('../src/session-tree');
const { directoryPickerItems, chooseDirectoryWithPicker } = require('../src/session-add');
const { pickConversation } = require('../src/session-picker');
const { showSessionDiagnostics } = require('../src/session-actions');
const { CompletionStatusBar } = require('../src/completion-notifications');

const root = path.resolve(__dirname, '..');
const locales = ['zh-cn', 'zh-tw', 'ja', 'ko'];

test('maps VS Code locale aliases to supported extension locales', () => {
  for (const [input, expected] of [
    ['zh-CN', 'zh-cn'], ['zh-Hans', 'zh-cn'], ['zh-Hans-SG', 'zh-cn'], ['zh-SG', 'zh-cn'],
    ['zh-TW', 'zh-tw'], ['zh-TW-x-private', 'zh-tw'], [' zh-TW ', 'zh-tw'], ['zh-Hant', 'zh-tw'], ['zh-HK', 'zh-tw'], ['zh-MO', 'zh-tw'],
    ['ja-JP', 'ja'], ['ko-KR', 'ko'], ['fr-FR', 'en'], ['', 'en']
  ]) assert.equal(normalizeLocale(input), expected, input);
});

test('runtime preference supports auto, manual language, invalid fallback, and live status retranslation', () => {
  setLocale('zh-CN', 'auto');
  assert.equal(getLocale(), 'zh-cn');
  setLocale('fr-FR', 'ja');
  assert.equal(getLocale(), 'ja');
  const sourceReason = 'Waiting for the agent session binding to be identified.';
  setLocale('fr-FR', 'zh-cn');
  assert.equal(retranslate(sourceReason), '正在等待识别智能体会话绑定信息。');
  setLocale('en', 'en');
  assert.equal(retranslate('正在等待识别智能体会话绑定信息。'), sourceReason);
  setLocale('ja-JP', 'ja');
  assert.equal(retranslate('正在等待识别智能体会话绑定信息。'), 'エージェントセッションの紐付け情報を特定しています。');
  assert.equal(retranslate('Project directory not found: /private/work'), 'Project directory not found: /private/work');
  setLocale('ko-KR', 'ko');
  assert.equal(retranslate('復元に失敗'), '복원 실패');
  setLocale('ja-JP', 'invalid');
  assert.equal(getLocale(), 'ja');
  setLocale('zh-TW', '');
  assert.equal(getLocale(), 'zh-tw');
});

test('runtime translations preserve placeholders and fall back to English', () => {
  setLocale('ja-JP');
  assert.equal(t('Project directory not found: {0}', ['/work/app']), 'プロジェクトディレクトリが見つかりません: /work/app');
  setLocale('fr-FR');
  assert.equal(t('Project directory not found: {0}', ['/work/app']), 'Project directory not found: /work/app');
  setLocale('en');
});

test('all locale resources have the same keys and preserve runtime placeholders', () => {
  const resources = locales.map(locale => JSON.parse(fs.readFileSync(path.join(root, `package.nls.${locale}.json`), 'utf8')));
  const keys = Object.keys(resources[0]).sort();
  for (const resource of resources.slice(1)) assert.deepEqual(Object.keys(resource).sort(), keys);
  for (const key of keys.filter(key => !key.startsWith('manifest.'))) {
    const sourcePlaceholders = [...key.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
    for (const resource of resources) assert.deepEqual([...resource[key].matchAll(/\{\d+\}/g)].map(match => match[0]).sort(), sourcePlaceholders, key);
  }
});

test('every manifest localization reference resolves and welcome action stays wired', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const languageSetting = manifest.contributes.configuration.properties['agentSessionRestore.language'];
  assert.equal(languageSetting.default, 'auto');
  assert.equal(languageSetting.scope, 'application');
  assert.deepEqual(languageSetting.enum, ['auto', 'en', 'zh-cn', 'zh-tw', 'ja', 'ko']);
  const refs = [];
  const visit = value => {
    if (typeof value === 'string') { for (const match of value.matchAll(/%([^%]+)%/g)) refs.push(match[1]); }
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(manifest);
  const base = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
  for (const locale of ['package.nls.json', ...locales.map(value => `package.nls.${value}.json`)]) {
    const resource = JSON.parse(fs.readFileSync(path.join(root, locale), 'utf8'));
    for (const key of refs) assert.ok(Object.hasOwn(resource, key), `${locale} missing ${key}`);
  }
  const welcomeKey = manifest.contributes.viewsWelcome[0].contents.match(/^%([^%]+)%$/)?.[1];
  assert.ok(welcomeKey);
  for (const locale of locales) assert.match(JSON.parse(fs.readFileSync(path.join(root, `package.nls.${locale}.json`), 'utf8'))[welcomeKey], /command:agentSessionRestore\.add/);
});

test('completion notification language refresh keeps pending items', () => {
  setLocale('en');
  const item = { hide() {}, show() {}, dispose() {} };
  const vscode = { StatusBarAlignment: { Right: 1 }, commands: { executeCommand: async () => {} }, window: { createStatusBarItem: () => item } };
  const statusBar = new CompletionStatusBar(vscode);
  statusBar.add({ id: 'session-1', provider: 'codex', sessionId: 'thread-1', name: 'Demo', cwd: '/work/demo' }, 'completion-1');
  setLocale('ko');
  statusBar.refreshLanguage();
  assert.equal(statusBar.pending.length, 1);
  assert.equal(item.name, 'Rekindle 완료된 세션');
  assert.match(item.accessibilityInformation.label, /완료된 에이전트 세션/);
  statusBar.dispose();
  setLocale('en');
});

test('session tree status and picker labels use the selected display language', async () => {
  setLocale('ja-JP');
  class TreeItem { constructor(label) { this.label = label; } }
  const vscode = {
    TreeItem, ThemeColor: class ThemeColor {}, ThemeIcon: class ThemeIcon {}, Uri: { file: value => value }, TreeItemCollapsibleState: { None: 0, Expanded: 1, Collapsed: 2 },
    window: { terminals: [] },
    workspace: { getConfiguration: section => ({ get: key => key === 'sessionPulse' ? false : undefined }) }
  };
  const tree = Object.create(SessionTree.prototype);
  tree.vscode = vscode;
  tree.manager = { live: new Map(), working: new Set(), status: new Map() };
  const item = tree.getTreeItem({ id: 'id', name: 'Demo', provider: 'codex', cwd: '/work/demo', sessionId: 'abc', enabled: false, historyOnly: false });
  assert.match(item.description, /自動復元オフ/);
  assert.match(item.tooltip, /セッション: abc/);
  assert.match(item.tooltip, /自動復元が無効/);
  tree.view = { description: '' };
  tree.groupBy = 'folder'; tree.workspaceOnly = true; tree.showHistory = true; tree.historyRangeDays = 30;
  tree.manager.hiddenHistory = new Set();
  tree.vscode.commands = { executeCommand: async () => {} };
  await tree.syncContext();
  assert.match(tree.view.description, /過去 30 日間/);
  assert.doesNotMatch(tree.view.description, /履歴.*履歴/);
  const pickerRows = directoryPickerItems('/tmp/demo', [], undefined, [], undefined);
  assert.match(pickerRows[0].label, /使用/);
  const pickerEvents = {};
  const disposable = { dispose() {} };
  const directoryPicker = { onDidChangeValue: callback => (pickerEvents.change = callback, disposable), onDidAccept: callback => (pickerEvents.accept = callback, disposable), onDidHide: callback => (pickerEvents.hide = callback, disposable), show() {}, dispose() {}, value: '', items: [] };
  const directoryPromise = chooseDirectoryWithPicker({ window: { createQuickPick: () => directoryPicker } }, { folders: [] });
  assert.equal(directoryPicker.title, '会話の作業ディレクトリ');
  pickerEvents.hide();
  await directoryPromise;
  let captured;
  const disposables = { dispose() {} };
  const picker = { onDidChangeValue: () => disposables, onDidAccept: () => disposables, onDidHide: () => disposables, show() {}, dispose() {}, hide() {}, value: '', items: [], selectedItems: [], activeItems: [] };
  setLocale('ja-JP');
  const pendingPicker = pickConversation({ window: { createQuickPick: () => picker } }, 'Codex', []);
  captured = picker.items.map(row => row.label).join(' ');
  assert.match(captured, /新しいセッションを作成/);
  assert.match(captured, /セッション ID を入力/);
  let diagnosticMessage = '';
  const session = { id: 's1', provider: 'codex', sessionId: 'abc', name: 'Demo', cwd: '/work/demo' };
  await showSessionDiagnostics({
    vscode: { window: { showInformationMessage: async message => { diagnosticMessage = message; } } },
    manager: { entries: [session], status: new Map([['s1', { state: 'working' }]]) },
    tree: {}, output: { show() {} }, entry: session
  });
  assert.match(diagnosticMessage, /状態: 作業中/);
  assert.doesNotMatch(diagnosticMessage, /状態: working/);
  setLocale('en');
});
