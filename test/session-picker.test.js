'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pickConversation} = require('../src/session-picker');

function setup() {
  const handlers = {};
  const picker = {value:'', selectedItems:[], activeItems:[], show(){}, dispose(){this.disposed=true;}, hide(){handlers.hide();}};
  for (const [event,name] of [['ChangeValue','change'],['Accept','accept'],['Hide','hide']]) picker[`onDid${event}`] = callback => {handlers[name]=callback;return {dispose(){}};};
  return {picker,handlers,vscode:{window:{createQuickPick:()=>picker}}};
}

test('typing a prefix of an existing Chinese title still offers an independent new conversation', async () => {
  const {picker,handlers,vscode} = setup();
  const existing={provider:'codex',title:'测试？？？',cwd:'/work',sessionId:'old-id'};
  const result=pickConversation(vscode,'Codex',[existing]);
  picker.value='测试';handlers.change();
  assert.equal(picker.activeItems[0].create,true);
  assert.equal(picker.activeItems[0].name,'测试');
  assert.equal(picker.activeItems[0].label,'$(add) 测试');
  assert.equal(picker.activeItems[0].description,'Create new session');
  assert.equal(picker.activeItems[0].alwaysShow,true);
  handlers.accept();
  const selection=await result;
  assert.equal(selection.create,true);
  assert.equal(selection.session,undefined);
  assert.equal(selection.name,'测试');
  assert.equal(picker.disposed,true);
});

test('explicitly selecting history restores the exact conversation; cancel creates nothing', async () => {
  const {picker,handlers,vscode}=setup();
  const existing={title:'测试',cwd:'/work',sessionId:'exact-id'};
  const result=pickConversation(vscode,'Codex',[existing]);
  picker.selectedItems=[picker.items.find(item=>item.session)];handlers.accept();
  assert.equal((await result).session,existing);
  const cancelled=setup();
  const pending=pickConversation(cancelled.vscode,'Codex',[]);
  cancelled.picker.hide();
  assert.equal(await pending,undefined);
});
