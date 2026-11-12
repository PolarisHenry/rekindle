'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const packageJson = require('../package.json');
const { chooseProvider, resolveAddContext, dispatchAddHere, resolveWorkingDirectory, directoryPickerItems, chooseDirectoryWithPicker } = require('../src/session-add');
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

test('provider group context skips provider chooser; folder context keeps provider selection sorted by name length', async () => {
  let calls=0;
  const seen=[];
  const vscode={window:{showQuickPick:async options=>{calls++;seen.push(options.map(item=>item.label));return options[0];}}};
  assert.deepEqual(await chooseProvider(vscode,{kind:'agent',provider:'claude'}),{label:'Claude Code',value:'claude'});
  assert.equal(calls,0);
  assert.deepEqual(await chooseProvider(vscode,{kind:'folder',cwd:'/work'}),{label:'pi',value:'pi'});
  assert.equal(calls,1);
  assert.deepEqual(seen[0],['pi','Codex','Claude Code','Antigravity'],'agents are offered shortest name first');
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

function directoryPickerMock() {
  const listeners = { value: [], accept: [], hide: [] };
  const picker = {
    value: '',
    items: [],
    validationMessage: undefined,
    busy: false,
    selectedItems: [],
    onDidChangeValue: fn => (listeners.value.push(fn), { dispose() {} }),
    onDidAccept: fn => (listeners.accept.push(fn), { dispose() {} }),
    onDidHide: fn => (listeners.hide.push(fn), { dispose() {} }),
    show() {},
    dispose() {},
    hide() { for (const fn of [...listeners.hide]) fn(); },
    async accept(item) { picker.selectedItems = [item]; for (const fn of [...listeners.accept]) await fn(); },
    type(text) { picker.value = text; for (const fn of [...listeners.value]) fn(); }
  };
  return picker;
}

test('directory picker lists workspace, current, and recent folders with a typed-path item', () => {
  const items = directoryPickerItems('/tmp/typed', ['/work/a', '/work/b', '/tmp/recent'], '/work/a', ['/tmp/recent'], '/work/active');
  assert.equal(items[0].typedPath, '/tmp/typed');
  const recent = items.find(item => item.cwd === '/tmp/recent');
  assert.equal(recent.description, 'Recently used');
  assert.equal(items.find(item => item.cwd === '/work/a').description, 'Current folder');
  const active = items.find(item => item.cwd === '/work/active');
  assert.equal(active.description, 'Active terminal folder');
  assert.ok(items.indexOf(active) > items.findIndex(item => item.cwd === '/work/b'), 'the active terminal folder is listed after workspace folders');
  assert.ok(items.at(-1).browse);
  const expanded = directoryPickerItems('~/projects', ['/work/a'], undefined, []);
  assert.ok(expanded[0].typedPath.endsWith('/projects') && path.isAbsolute(expanded[0].typedPath));
});

test('the toolbar folder picker stays isolated: workspace folder first, active terminal folder never preselected', async () => {
  const picker = directoryPickerMock();
  const vscode = { window: { createQuickPick: () => picker } };
  const done = chooseDirectoryWithPicker(vscode, { folders: ['/work/root'], active: '/work/root/sub/agent-folder', stat: fs.stat });
  const first = picker.items.find(item => item.cwd);
  assert.equal(first.cwd, '/work/root', 'no explicit context means the workspace folder is the default');
  assert.equal(picker.items.find(item => item.cwd === '/work/root/sub/agent-folder').description, 'Active terminal folder');
  await picker.accept(first);
  picker.hide();
  assert.equal(await done, '/work/root');
});

test('explicit group context still preselects its folder and Browse opens at the default folder', async () => {
  const picker = directoryPickerMock();
  const vscode = { window: { createQuickPick: () => picker } };
  const dialogDefaults = [];
  const done = chooseDirectoryWithPicker(vscode, {
    folders: ['/work/root'], suggested: '/work/root/group', openDialog: async defaultFolder => { dialogDefaults.push(defaultFolder); return '/picked/from/dialog'; }
  });
  assert.equal(picker.items.find(item => item.cwd).cwd, '/work/root/group');
  await picker.accept(picker.items.find(item => item.browse));
  assert.equal(await done, '/picked/from/dialog');
  assert.deepEqual(dialogDefaults, ['/work/root/group']);

  const root = directoryPickerMock();
  const rootDone = chooseDirectoryWithPicker({ window: { createQuickPick: () => root } }, { folders: ['/work/root'], openDialog: async defaultFolder => { dialogDefaults.push(defaultFolder); return '/x'; } });
  await root.accept(root.items.find(item => item.browse));
  await rootDone;
  assert.deepEqual(dialogDefaults, ['/work/root/group', '/work/root'], 'the toolbar Browse opens at the first workspace folder');
});

test('typed folder paths resolve after validation while invalid ones keep the picker open', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-folder-picker-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const picker = directoryPickerMock();
  const vscode = { window: { createQuickPick: () => picker } };
  const done = chooseDirectoryWithPicker(vscode, { folders: ['/work/a'], stat: fs.stat });
  picker.type(dir);
  const typed = picker.items.find(item => item.typedPath);
  assert.equal(typed.typedPath, dir);
  await picker.accept(typed);
  picker.hide();
  assert.equal(await done, dir);

  const invalid = directoryPickerMock();
  const vscodeInvalid = { window: { createQuickPick: () => invalid } };
  const pending = chooseDirectoryWithPicker(vscodeInvalid, { folders: [], stat: fs.stat });
  invalid.type('/definitely/not/a/folder');
  await invalid.accept(invalid.items.find(item => item.typedPath));
  assert.match(invalid.validationMessage, /Not an existing folder/);
  await invalid.accept(invalid.items.find(item => item.cwd === undefined && !item.browse) || { cwd: undefined });
  await invalid.accept(invalid.items[0]);
  invalid.hide();
  assert.equal(await pending, undefined);
});

test('Browse keeps the native dialog optional and returns its picked folder', async () => {
  const picker = directoryPickerMock();
  const vscode = { window: { createQuickPick: () => picker } };
  const done = chooseDirectoryWithPicker(vscode, { folders: ['/work/a'], openDialog: async () => '/picked/from/dialog' });
  await picker.accept(picker.items.find(item => item.browse));
  assert.equal(await done, '/picked/from/dialog');
});

test('Browse survives VS Code hiding the folder QuickPick while the native dialog is open', async () => {
  const picker = directoryPickerMock();
  const vscode = { window: { createQuickPick: () => picker } };
  const done = chooseDirectoryWithPicker(vscode, {
    folders: ['/work/a'],
    openDialog: async () => {
      // VS Code may hide the QuickPick when the native open dialog takes focus.
      picker.hide();
      return '/picked/from/dialog';
    }
  });
  await picker.accept(picker.items.find(item => item.browse));
  assert.equal(await done, '/picked/from/dialog');
});

test('canceling Browse reopens the folder QuickPick if the native dialog hid it', async () => {
  const picker = directoryPickerMock();
  let showCount = 0;
  picker.show = () => { showCount++; };
  const vscode = { window: { createQuickPick: () => picker } };
  const done = chooseDirectoryWithPicker(vscode, {
    folders: ['/work/a'],
    openDialog: async () => {
      picker.hide();
      return undefined;
    }
  });
  await picker.accept(picker.items.find(item => item.browse));
  assert.equal(showCount, 2, 'the initial picker is shown again after dialog cancellation');
  assert.equal(picker.items.find(item => item.cwd).cwd, '/work/a');
  await picker.accept(picker.items.find(item => item.cwd === '/work/a'));
  assert.equal(await done, '/work/a');
});
