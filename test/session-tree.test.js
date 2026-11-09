'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groupedSessions, SessionTree } = require('../src/session-tree');
const row = (id, cwd, enabled = true) => ({ id, provider: 'pi', sessionId: id, name: id, cwd, enabled });

test('default sidebar groups only enabled sessions by their actual folder', () => {
  const groups = groupedSessions([row('a','/work/first'),row('b','/work/second'),row('c','/work/first',false)], [], false);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].sessions.map(entry => entry.id), ['a']);
  assert.equal(groups[1].cwd, '/work/second');
});

test('history merges native conversations without duplicating tracked sessions', () => {
  const tracked = [row('a','/work'),row('b','/work',false)];
  const history = [{ ...row('a','/work'), title: 'native title' }, { ...row('c','/other'), title: 'old conversation' }];
  const groups = groupedSessions(tracked, history, true);
  assert.equal(groups.flatMap(folder => folder.sessions).length, 3);
  assert.equal(groups.find(folder => folder.cwd === '/work').sessions[0].name, 'a');
  const native = groups.find(folder => folder.cwd === '/other').sessions[0];
  assert.equal(native.enabled, false);
  assert.equal(native.historyOnly, true);
});

test('workspace scope excludes unrelated folders without matching path prefixes', () => {
  const groups = groupedSessions([row('a','/work/app'), row('b','/work/app/sub'), row('c','/work/application')], [], false, { workspaceFolders: ['/work/app'] });
  assert.deepEqual(groups.flatMap(group => group.sessions.map(entry => entry.id)).sort(), ['a','b']);
});

test('all-folders mode still prioritizes the current terminal folder', () => {
  const groups = groupedSessions([row('a','/aaa/other'), row('z','/work/z-project'), row('b','/work/app')], [], false, {
    workspaceFolders: ['/work'], workspaceOnly: false, currentFolder: '/work/z-project'
  });
  assert.equal(groups[0].cwd, '/work/z-project');
  assert.equal(groups.at(-1).cwd, '/aaa/other');
});

test('agent grouping combines providers and prioritizes their current-folder sessions', () => {
  const tracked = [row('other','/work/other'), row('current','/work/current'), { ...row('claude','/work/current'), provider:'claude' }];
  const groups = groupedSessions(tracked, [], false, { groupBy:'agent', workspaceFolders:['/work'], currentFolder:'/work/current' });
  assert.equal(groups.length,2);
  assert.ok(groups.every(group => group.kind==='agent'));
  assert.equal(groups.find(group => group.provider==='pi').sessions[0].id,'current');
});

test('folder-first grouping separates providers inside each exact folder', () => {
  const tracked = [row('pi-a','/work/app'), row('pi-b','/work/app'),
    { ...row('codex','/work/app'), provider:'codex' }, row('elsewhere','/other/app')];
  const groups = groupedSessions(tracked, [], false, { groupBy:'folder' });
  const app = groups.find(group => group.cwd === '/work/app');
  assert.deepEqual(app.children.map(group => group.provider), ['codex','pi']);
  assert.deepEqual(app.children.find(group => group.provider === 'pi').sessions.map(entry => entry.id), ['pi-a','pi-b']);
  assert.equal(app.children.find(group => group.provider === 'codex').sessions[0].id,'codex');
  assert.equal(new Set(groups.flatMap(group => [group.groupId,...group.children.map(child => child.groupId)])).size,5);
});

test('agent-first grouping keeps same-named folders distinct and current folder first', () => {
  const groups = groupedSessions([row('other','/other/app'), row('current','/work/app'), row('paused','/work/app',false)], [], true, {
    groupBy:'agent', currentFolder:'/work/app', workspaceOnly:false
  });
  assert.equal(groups[0].provider,'pi');
  assert.deepEqual(groups[0].children.map(group => group.cwd), ['/work/app','/other/app']);
  assert.deepEqual(groups[0].children[0].sessions.map(entry => entry.id), ['current','paused']);
});

test('tree exposes both grouping levels before actionable session leaves', async () => {
  const v = {
    TreeItem: class { constructor(label,collapsibleState) { Object.assign(this,{label,collapsibleState}); } },
    TreeItemCollapsibleState: { None:0, Collapsed:1, Expanded:2 },
    TreeItemCheckboxState: { Checked:1, Unchecked:0 },
    ThemeIcon: class { constructor(id) {this.id=id;} },
    Uri: {file:fsPath=>({fsPath})}, window:{terminals:[]}
  };
  for (const mode of ['folder','agent']) {
    const roots = groupedSessions([row('a','/work/app'), row('b','/other/app')], [], false, {groupBy:mode});
    const tree = {vscode:v,manager:{live:new Map()}};
    for (const root of roots) {
      const children = await SessionTree.prototype.getChildren.call(tree,root);
      assert.ok(children.every(child=>child.kind === (mode==='folder'?'agent':'folder')));
      for (const child of children) {
        const leaves = await SessionTree.prototype.getChildren.call(tree,child);
        assert.ok(leaves.every(leaf=>!leaf.kind));
        const groupItem = SessionTree.prototype.getTreeItem.call(tree,child);
        assert.equal(groupItem.checkboxState,undefined);
        const leafItem = SessionTree.prototype.getTreeItem.call(tree,leaves[0]);
        assert.equal(leafItem.command.arguments[0],leaves[0]);
        assert.equal(leafItem.checkboxState,v.TreeItemCheckboxState.Checked);
        assert.ok(leafItem.iconPath.fsPath.endsWith('/media/agents/pi.svg'));
      }
    }
  }
});
