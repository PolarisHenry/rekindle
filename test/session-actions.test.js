'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {selectSession,showSessionDiagnostics,openCompletedSession}=require('../src/session-actions');

test('command-palette actions can select a saved session without mutating it',async()=>{
 const entry={id:'saved',provider:'codex',sessionId:'exact',name:'Saved',cwd:'/work'};
 let quickPickCalls=0;
 const vscode={window:{showQuickPick:async()=>{quickPickCalls++;return {entry};}}};
 const manager={entries:[entry]};
 const tree={showHistory:false,view:{selection:[]},history:[]};
 assert.equal(await selectSession(vscode,manager,tree),entry);
 assert.equal(manager.entries.length,1);
 assert.equal(quickPickCalls,1);
 const direct={...entry,selected:true}; assert.equal(await selectSession(vscode,manager,tree,direct),direct);
 assert.equal(quickPickCalls,1,'direct session contexts do not re-open the picker');
});

test('selected tree session is preferred and diagnostic Open Session tracks and opens a native row only after click',async()=>{
 const entry={id:'history:pi:old',provider:'pi',sessionId:'old',title:'Old',cwd:'/work'};
 let quickPickCalls=0,tracked=0,opened=[];
 const vscode={window:{showQuickPick:async()=>{quickPickCalls++;return undefined;},showInformationMessage:async(message,...actions)=>{assert.match(message,/State: saved/);return 'Open Session';}}};
 const manager={entries:[],status:new Map(),open:async row=>opened.push(row.id)};
 const tree={showHistory:true,view:{selection:[entry]},history:[],async ensureTracked(row){tracked++;return {...row,id:'tracked-old'};}};
 assert.equal(await selectSession(vscode,manager,tree),entry);
 assert.equal(quickPickCalls,0);
 await showSessionDiagnostics({vscode,manager,tree,output:{show(){} }});
 assert.equal(tracked,1);
 assert.deepEqual(opened,['tracked-old']);
});

test('diagnostic dismissal is inert and failure action retries the exact tracked entry',async()=>{
 const entry={id:'failed',provider:'claude',sessionId:'s',name:'Failed',cwd:'/work'};
 let opened=[],shown='Retry Restore';
 const vscode={window:{showInformationMessage:async(message,...actions)=>{assert.match(message,/Could not start/);assert.deepEqual(actions,['Retry Restore','Open Logs']);return shown;}}};
 const manager={entries:[entry],status:new Map([['failed',{state:'restore-failed',reason:'Could not start'}]]),open:async(row,reveal)=>opened.push([row.id,reveal])};
 const tree={showHistory:false,view:{selection:[entry]},history:[]};
 await showSessionDiagnostics({vscode,manager,tree,output:{show(){}}});
 assert.deepEqual(opened,[['failed',true]]);
 opened=[]; shown=undefined;
 await showSessionDiagnostics({vscode,manager,tree,output:{show(){}}});
 assert.deepEqual(opened,[]);
});

 test('completion links open only the still-matching saved conversation once',async()=>{
 const entry={id:'id',provider:'pi',sessionId:'exact'};const calls=[];
 const manager={entries:[entry],open:async(...args)=>calls.push(args)};
 await openCompletedSession(manager,'id','pi','old');
 await openCompletedSession(manager,'deleted','pi','exact');
 assert.deepEqual(calls,[]);
 await openCompletedSession(manager,'id','pi','exact');
 assert.deepEqual(calls,[[entry,true]]);
 });
