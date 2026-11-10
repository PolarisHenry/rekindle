'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const packageJson = require('../package.json');
const { chooseProvider, resolveAddContext, dispatchAddHere, resolveWorkingDirectory } = require('../src/session-add');
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

test('explicit folder contexts reuse their directory and skip the folder chooser', async () => {
  const rows=[
    {provider:'pi',sessionId:'p',name:'pi',cwd:'/work/app'},
    {provider:'claude',sessionId:'c',name:'claude',cwd:'/work/app'}
  ];
  const folderRoot=groupedSessions(rows,[],false,{groupBy:'folder'}).find(node=>node.kind==='folder');
  const nestedAgent=folderRoot.children.find(node=>node.kind==='agent'&&node.provider==='claude');
  const agentRoot=groupedSessions(rows,[],false,{groupBy:'agent'}).find(node=>node.kind==='agent'&&node.provider==='pi');
  const nestedFolder=agentRoot.children.find(node=>node.kind==='folder');
  const explorer=resolveAddContext({uri:{fsPath:'/explorer/right-click'}});
  const commandPath=resolveAddContext('/command/path');
  const selected=[folderRoot,nestedAgent,nestedFolder,explorer,commandPath].map(resolveAddContext);
  const chooserCalls=[];
  const chooseDirectory=async (...args)=>{chooserCalls.push(args);return '/picked';};
  const stat=async cwd=>({isDirectory:()=>['/work/app','/explorer/right-click','/command/path'].includes(cwd)});
  for (const context of selected) {
    assert.equal(await resolveWorkingDirectory({cwd:context.cwd,folders:['/workspace'],suggested:'/active',chooseDirectory,stat}),context.cwd);
  }
  assert.equal(chooserCalls.length,0);
});

test('toolbar and root Agent contexts still open the directory chooser with active cwd suggested', async () => {
  const choices=[];
  const chooseDirectory=async (folders,suggested)=>{choices.push({folders,suggested});return '/chosen';};
  const pureAgent={provider:'pi'};
  const toolbar={};
  assert.equal(await resolveWorkingDirectory({cwd:resolveAddContext(pureAgent).cwd,folders:['/workspace'],suggested:'/active/terminal',chooseDirectory}),'/chosen');
  assert.equal(await resolveWorkingDirectory({cwd:resolveAddContext(toolbar).cwd,folders:['/workspace'],suggested:'/active/terminal',chooseDirectory}),'/chosen');
  assert.deepEqual(choices,[
    {folders:['/workspace'],suggested:'/active/terminal'},
    {folders:['/workspace'],suggested:'/active/terminal'}
  ]);
});

test('an invalid explicit folder reports the chosen path instead of silently selecting another', async () => {
  let chooserCalls=0;
  await assert.rejects(resolveWorkingDirectory({
    cwd:'/gone/folder',folders:['/workspace'],suggested:'/active',
    chooseDirectory:async()=>{chooserCalls++;return '/workspace';},
    stat:async()=>{throw new Error('missing');}
  }),/The selected folder is unavailable: \/gone\/folder/);
  assert.equal(chooserCalls,0);
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
