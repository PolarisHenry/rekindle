'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groupedSessions, SessionTree } = require('../src/session-tree');
const row = (id, cwd, enabled = true) => ({ id, provider: 'pi', sessionId: id, name: id, cwd, enabled });

test('default sidebar hides disabled sessions while history reveals them', () => {
  const groups = groupedSessions([row('a','/work/first'),row('b','/work/second'),row('c','/work/first',false)], [], false);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].sessions.map(entry => entry.id), ['a']);
  assert.equal(groups[1].cwd, '/work/second');
  assert.deepEqual(groupedSessions([row('a','/work/first'),row('c','/work/first',false)], [], true)[0].sessions.map(entry => entry.id), ['a','c']);
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
        assert.equal(leafItem.checkboxState,undefined);
        assert.ok(leafItem.iconPath.fsPath.endsWith('/media/agents/pi.svg'));
      }
    }
  }
});

test('idle open terminals are not labeled Running; active lifecycle state shows Working', () => {
  const v={TreeItem:class{constructor(label,state){Object.assign(this,{label,collapsibleState:state});}},TreeItemCollapsibleState:{None:0},ThemeIcon:class{},Uri:{file:fsPath=>({fsPath})},window:{terminals:[]}};
  const terminal={};
  v.window.terminals.push(terminal);
  const entry=row('a','/work');
  const manager={live:new Map([['a',terminal]]),working:new Set()};
  const tree={vscode:v,manager};
  assert.equal(SessionTree.prototype.getTreeItem.call(tree,entry).description,'');
  manager.working.add('a');
  assert.equal(SessionTree.prototype.getTreeItem.call(tree,entry).description,'Working');
});

test('disabling hides a session by default and Show History retains its position', () => {
  const tracked = [row('a','/work'),row('b','/work'),row('c','/work')];
  for (const groupBy of ['folder','agent']) {
    const before = groupedSessions(tracked,[],true,{groupBy});
    tracked[0].enabled=false;
    const after = groupedSessions(tracked,[],true,{groupBy});
    assert.deepEqual(after.map(group=>group.sessions.map(entry=>entry.id)),before.map(group=>group.sessions.map(entry=>entry.id)));
    assert.deepEqual(groupedSessions(tracked,[],false,{groupBy}).flatMap(group=>group.sessions.map(entry=>entry.id)),['b','c']);
    tracked[0].enabled=true;
  }
});

test('search matches names, paths, agent labels and IDs without changing scope', () => {
  const tracked = [row('库存核对','/work/shop'), {...row('abc-id','/work/app'), provider:'claude'}, row('outside','/elsewhere')];
  const options = {workspaceFolders:['/work'],search:'CLAUDE app'};
  assert.deepEqual(groupedSessions(tracked,[],false,options).flatMap(group=>group.sessions.map(entry=>entry.id)), ['abc-id']);
  for (const search of ['库存','shop']) assert.equal(groupedSessions(tracked,[],false,{...options,search})[0].sessions[0].id,'库存核对');
  assert.equal(groupedSessions(tracked,[],false,{...options,search:'outside'}).length,0);
  assert.equal(groupedSessions(tracked,[],false,{...options,search:'missing'}).length,0);
});

test('history reveals disabled, archived, and native sessions', () => {
  const tracked = [row('disabled','/work',false), {...row('archived','/work',false),archived:true}];
  const history = [row('native','/work')];
  assert.deepEqual(groupedSessions(tracked,history,false),[]);
  assert.deepEqual(groupedSessions(tracked,history,true)[0].sessions.map(entry=>entry.sessionId),['archived','disabled','native']);
});

test('search edits filter live, Enter keeps the query, and Escape restores the prior query', async () => {
  for (const accept of [false,true]) {
    const handlers={};
    const input={value:'',show(){},hide(){handlers.hide();},dispose(){this.disposed=true;}};
    for (const [event,name] of [['ChangeValue','change'],['Accept','accept'],['Hide','hide']]) input[`onDid${event}`]=callback=>{handlers[name]=callback;return {dispose(){}};};
    const tree={search:'old',vscode:{window:{createInputBox:()=>input}}, async setSearch(value){this.search=value.trim();}};
    await SessionTree.prototype.searchSessions.call(tree);
    handlers.change('new query');
    assert.equal(tree.search,'new query');
    if (accept) handlers.accept(); else input.hide();
    assert.equal(tree.search,accept?'new query':'old');
    assert.equal(input.disposed,true);
  }
});
