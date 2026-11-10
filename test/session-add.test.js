'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const packageJson = require('../package.json');
const { chooseProvider, resolveAddContext, dispatchAddHere } = require('../src/session-add');
const { groupedSessions } = require('../src/session-tree');

test('group actions preserve cwd and provider for either grouping order', () => {
  const rows=[
    {provider:'pi',sessionId:'p',name:'pi',cwd:'/work/app'},
    {provider:'claude',sessionId:'c',name:'claude',cwd:'/work/app'}
  ];
  const folderTree=groupedSessions(rows,[],false,{groupBy:'folder'});
  const folderRoot=folderTree.find(node=>node.kind==='folder');
  const nestedAgent=folderRoot.children.find(node=>node.kind==='agent'&&node.provider==='claude');
  const agentTree=groupedSessions(rows,[],false,{groupBy:'agent'});
  const agentRoot=agentTree.find(node=>node.kind==='agent'&&node.provider==='pi');
  const nestedFolder=agentRoot.children.find(node=>node.kind==='folder');
  const contexts=[folderRoot,nestedAgent,agentRoot,nestedFolder];
  assert.deepEqual(contexts.map(resolveAddContext), [
    { cwd:'/work/app' },
    { cwd:'/work/app', provider:'claude' },
    { provider:'pi' },
    { cwd:'/work/app', provider:'pi' }
  ]);
  assert.deepEqual(resolveAddContext('/explorer/folder'), { cwd:'/explorer/folder' });
});

test('provider group context skips provider chooser; folder context keeps provider selection', async () => {
  let calls=0;
  const vscode={window:{showQuickPick:async options=>{calls++;return options[0];}}};
  assert.deepEqual(await chooseProvider(vscode,{kind:'agent',provider:'claude'}),{label:'Claude Code',value:'claude'});
  assert.equal(calls,0);
  assert.deepEqual(await chooseProvider(vscode,{kind:'folder',cwd:'/work'}),{label:'Codex',value:'codex'});
  assert.equal(calls,1);
});

test('New Session Here forwards the full tree context to Add Session', async () => {
  const context={kind:'folder',cwd:'/work/app',provider:'pi'};
  let call;
  await dispatchAddHere(context,(...args)=>{call=args;});
  assert.deepEqual(call,['agentSessionRestore.add',context]);
});

test('Folder and Agent groups expose both inline plus and context menu actions', () => {
  const actions=packageJson.contributes.menus['view/item/context'].filter(item=>item.command==='agentSessionRestore.addHere');
  assert.equal(actions.length,2);
  assert.deepEqual(actions.map(item=>item.group).sort(),['1_create@1','inline@0']);
  assert.ok(actions.every(item=>item.when.includes('sessionFolder|sessionAgent')));
});
