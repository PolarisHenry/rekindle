'use strict';
const {test}=require('node:test');
const {openCompletedSession}=require('../src/session-actions');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {stripTypeScriptTypes}=require('node:module');
const {AutomaticTracker,descendants,terminalAgent,parseProcesses,parseOpenFiles,readCodexLifecycle,readManagedCodexSession,consumeCompletion,installPiBridge}=require('../src/automatic');

test('terminal ownership excludes nested agents and ambiguous sibling agents',()=>{
 const processes=parseProcesses('100 1 zsh\n101 100 pi\n102 101 sh\n103 102 agy\n104 103 pi\n200 1 zsh\n201 200 agy\n202 201 codex');
 assert.deepEqual([...terminalAgent(100,processes).children],[101,102]);
 assert.equal(terminalAgent(100,processes).provider,'pi');
 assert.equal(terminalAgent(200,processes).provider,'agy');
 assert.deepEqual([...terminalAgent(200,processes).children],[201]);
 const ambiguous=terminalAgent(100,[...processes,{pid:105,parent:100,command:'claude'}]);
 assert.equal(ambiguous.present,true);
 assert.equal(ambiguous.children.size,0);
});

test('nested AGY hook cannot change a pi terminal provider or session identity',async t=>{
 const fx=await codexSampleFixture(t);
 Object.assign(fx.entry,{provider:'pi',sessionId:'pi-original',automatic:true});
 fx.tracker.execFile=async()=>({stdout:'100 1 zsh\n101 100 pi\n102 101 sh\n103 102 agy\n'});
 await fs.writeFile(path.join(fx.tracker.registry,'103.json'),JSON.stringify({pid:103,provider:'agy',sessionId:'nested-agy',cwd:fx.dir,working:true}));
 const observed=[];
 fx.manager.observe=session=>{observed.push(session);return {entry:fx.entry,dirty:false};};
 await fx.tracker.sample();
 assert.deepEqual(observed,[],'nested hook is ignored even before pi publishes its first report');
 assert.equal(fx.entry.provider,'pi');
 assert.equal(fx.entry.sessionId,'pi-original');
 assert.equal(fx.manager.status.get(fx.entry.id).state,'unknown');
 await fs.writeFile(path.join(fx.tracker.registry,'101.json'),JSON.stringify({pid:101,provider:'pi',sessionId:'pi-original',cwd:fx.dir,working:true}));
 await fx.tracker.sample();
 assert.equal(observed.length,1);
 assert.equal(observed[0].provider,'pi');
 assert.equal(fx.manager.status.get(fx.entry.id).state,'working');
});

test('restored AGY waits for lifecycle without a false restore error and recovers on its first report',async t=>{
 const fx=await codexSampleFixture(t);
 Object.assign(fx.entry,{provider:'agy',sessionId:'agy-restored',automatic:true});
 fx.tracker.execFile=async()=>({stdout:'100 1 zsh\n101 100 agy\n'});
 const logs=[]; fx.tracker.log=message=>logs.push(message);
 await fx.tracker.sample();
 assert.match(fx.manager.status.get(fx.entry.id).reason,/Waiting for its first lifecycle report/);
 assert.equal(fx.entry.enabled,true);
 assert.equal(fx.manager.live.get(fx.entry.id),fx.terminal);
 assert.match(logs[0],/^Waiting for lifecycle report/);
 assert.deepEqual(fx.messages,[]);
 await fs.writeFile(path.join(fx.tracker.registry,'101.json'),JSON.stringify({pid:101,provider:'agy',sessionId:fx.entry.sessionId,cwd:fx.dir,working:true,activityAt:Date.now()}));
 await fx.tracker.sample();
 assert.equal(fx.manager.status.get(fx.entry.id).state,'working');
 await fs.writeFile(path.join(fx.tracker.registry,'101.json'),JSON.stringify({pid:101,provider:'agy',sessionId:fx.entry.sessionId,cwd:fx.dir,working:false,completedAt:Date.now()}));
 await fx.tracker.sample();
 assert.equal(fx.manager.status.get(fx.entry.id).state,'open');
 assert.equal(fx.messages.length,1);
});

async function codexSampleFixture(t, notifications = true, initialEvents = []) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rekindle-completion-sample-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const registry=path.join(dir,'registry');
 await fs.mkdir(registry);
 const sessionFile=path.join(dir,'rollout.jsonl');
 await fs.writeFile(sessionFile,JSON.stringify({type:'session_meta',payload:{id:'codex-session',cwd:dir}})+'\n');
 for(const event of initialEvents) await fs.appendFile(sessionFile,JSON.stringify({timestamp:new Date(event.timestamp ?? Date.now()).toISOString(),type:'event_msg',payload:event.payload})+'\n');
 const entry={id:'entry-id',provider:'codex',sessionId:'codex-session',sessionFile,cwd:dir,name:'Codex task',enabled:true};
 const terminal={processId:Promise.resolve(100),creationOptions:{env:{AGENT_SESSION_RESTORE_ID:entry.id}},show(preserve){this.shownWith=preserve;}};
 const messages=[],progress=[]; const opens=[];
 const vscode={
  workspace:{isTrusted:true,getConfiguration:()=>({get:(key,fallback)=>key==='completionNotifications'?notifications:fallback})},
  window:{terminals:[terminal],showInformationMessage:(message,...actions)=>{assert.deepEqual(actions,[],'completion must not use a dismissing notification button');messages.push(message);return Promise.resolve(undefined);}}
 };
 const manager={entries:[entry],live:new Map([[entry.id,terminal]]),working:new Set(),status:new Map(),changed(){},save:async()=>{},open:async(current)=>{opens.push(current.id); const target=manager.live.get(current.id); return target;}};
 manager.observe=session=>({entry:manager.entries.find(row=>row.sessionId===session.sessionId)||entry,dirty:false});
 const tracker=new AutomaticTracker(vscode,manager,()=>{}, {
  registry,
  execFile:async command=>command==='ps'?{stdout:'100 1 /bin/zsh\n101 100 /usr/local/bin/codex\n'}:{stdout:''},
  writeTerminalProgress:async(_terminal,working)=>{progress.push(working);return true;}
 });
 return {dir,sessionFile,entry,terminal,vscode,manager,tracker,messages,progress,opens};
}

async function appendCodexEvent(file,payload,timestamp=Date.now()) {
 await fs.appendFile(file,JSON.stringify({timestamp:new Date(timestamp).toISOString(),type:'event_msg',payload})+'\n');
}

test('Codex sample pipeline clears Working and shows exactly one completion toast',async t=>{
 const fx=await codexSampleFixture(t,true);
 await fx.tracker.sample();
 await appendCodexEvent(fx.sessionFile,{type:'task_started',turn_attribution:{kind:'user'},turn_id:'turn-one'});
 await fx.tracker.sample();
 assert.equal(fx.manager.working.has(fx.entry.id),true);
 assert.deepEqual(fx.messages,[]);
 await appendCodexEvent(fx.sessionFile,{type:'task_complete',turn_id:'turn-one',completed_at:Math.ceil(Date.now()/1000),last_agent_message:'private text'});
 await fx.tracker.sample();
 assert.equal(fx.manager.working.has(fx.entry.id),false);
 assert.equal(fx.messages.length,1); assert.match(fx.messages[0],/Codex · Codex task finished ·/);
 await fx.tracker.sample();
 assert.equal(fx.messages.length,1,'repeated idle sampling cannot notify twice');
 assert.ok(fx.progress.includes(true));
 assert.equal(fx.progress.at(-1),false);
});

test('notification action opens only the matching session on click; restart keeps turn deduplication',async t=>{
 const fx=await codexSampleFixture(t,true);
 await fx.tracker.sample();
 await appendCodexEvent(fx.sessionFile,{type:'task_started',turn_attribution:{kind:'user'},turn_id:'restart-turn'});
 await fx.tracker.sample();
 await appendCodexEvent(fx.sessionFile,{type:'task_complete',turn_id:'restart-turn',completed_at:Math.ceil(Date.now()/1000)});

 await fx.tracker.sample();
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(fx.opens,[],'showing a completion never opens a terminal');
 const match=fx.messages[0].match(/\[Open Session\]\(command:agentSessionRestore.openCompletedSession\?([^)]*)\)/);
 assert.ok(match,'completion uses a command link instead of a dismissing button');
 const args=JSON.parse(decodeURIComponent(match[1]));
 assert.deepEqual(args,[fx.entry.id,fx.entry.provider,fx.entry.sessionId]);
 await openCompletedSession(fx.manager,...args);
 assert.deepEqual(fx.opens,[fx.entry.id]);
 fx.tracker.closed(fx.terminal);
 const replacement={processId:Promise.resolve(100),creationOptions:{env:{AGENT_SESSION_RESTORE_ID:fx.entry.id}},show(preserve){this.shownWith=preserve;}};
 fx.vscode.window.terminals[0]=replacement;
 fx.manager.live.set(fx.entry.id,replacement);
 await fx.tracker.sample();
 assert.equal(fx.messages.length,1,'reopening a finished conversation does not repeat its completion toast');
});

test('Codex cold-start history is suppressed while a fast first-sample completion is notified',async t=>{
 const oldTime=Date.now()-60000;
 const old=await codexSampleFixture(t,true,[{timestamp:oldTime,payload:{type:'task_complete',turn_id:'old-turn',completed_at:Math.floor(oldTime/1000)}}]);
 await old.tracker.sample();
 assert.deepEqual(old.messages,[],'historical completions discovered on startup do not notify');
 assert.equal(old.manager.working.has(old.entry.id),false);

 const fast=await codexSampleFixture(t,true);
 const afterStart=fast.tracker.startedAt+2000;
 await appendCodexEvent(fast.sessionFile,{type:'task_started',turn_attribution:{kind:'user'},turn_id:'fast-turn'},afterStart);
 await appendCodexEvent(fast.sessionFile,{type:'task_complete',turn_id:'fast-turn',completed_at:Math.ceil(afterStart/1000)},afterStart+1);
 await fast.tracker.sample();
 assert.equal(fast.messages.length,1,'a task completed before first poll still produces one toast');
 assert.equal(fast.manager.working.has(fast.entry.id),false);
 await fast.tracker.sample();
 assert.equal(fast.messages.length,1);
});

test('turn tracking clears Working when notifications are disabled',async t=>{
 const fx=await codexSampleFixture(t,false);
 await fx.tracker.sample();
 await appendCodexEvent(fx.sessionFile,{type:'task_started',turn_attribution:{kind:'user'},turn_id:'quiet-turn'});
 await fx.tracker.sample();
 assert.equal(fx.manager.working.has(fx.entry.id),true);
 await appendCodexEvent(fx.sessionFile,{type:'task_complete',turn_id:'quiet-turn',completed_at:Math.ceil(Date.now()/1000)});
 await fx.tracker.sample();
 assert.equal(fx.manager.working.has(fx.entry.id),false);
 assert.deepEqual(fx.messages,[]);
});

test('Codex completion toasts stay bound to each session when two agents finish separately',async t=>{
 const fx=await codexSampleFixture(t,true);
 const secondDir=path.join(fx.dir,'second');
 await fs.mkdir(secondDir);
 const secondFile=path.join(secondDir,'rollout.jsonl');
 await fs.writeFile(secondFile,JSON.stringify({type:'session_meta',payload:{id:'codex-session-2',cwd:secondDir}})+'\n');
 const secondEntry={id:'entry-id-2',provider:'codex',sessionId:'codex-session-2',sessionFile:secondFile,cwd:secondDir,name:'Other task',enabled:true};
 const secondTerminal={processId:Promise.resolve(200),creationOptions:{env:{AGENT_SESSION_RESTORE_ID:secondEntry.id}}};
 fx.manager.entries.push(secondEntry);
 fx.manager.live.set(secondEntry.id,secondTerminal);
 fx.vscode.window.terminals.push(secondTerminal);
 fx.tracker.execFile=async command=>command==='ps'
  ? {stdout:'100 1 /bin/zsh\n101 100 /usr/local/bin/codex\n200 1 /bin/zsh\n201 200 /usr/local/bin/codex\n'}
  : {stdout:''};
 await fx.tracker.sample();
 await appendCodexEvent(fx.sessionFile,{type:'task_started',turn_attribution:{kind:'user'},turn_id:'first-turn'});
 await appendCodexEvent(secondFile,{type:'task_started',turn_attribution:{kind:'user'},turn_id:'second-turn'});
 await fx.tracker.sample();
 assert.deepEqual([...fx.manager.working].sort(),['entry-id','entry-id-2']);
 await appendCodexEvent(fx.sessionFile,{type:'task_complete',turn_id:'first-turn',completed_at:Math.ceil(Date.now()/1000)});
 await fx.tracker.sample();
 assert.equal(fx.messages.length,1);
 assert.equal(fx.manager.working.has('entry-id'),false);
 assert.equal(fx.manager.working.has('entry-id-2'),true);
 await appendCodexEvent(secondFile,{type:'task_complete',turn_id:'second-turn',completed_at:Math.ceil(Date.now()/1000)});
 await fx.tracker.sample();
 assert.equal(fx.messages.length,2); assert.match(fx.messages[1],/Other task finished/);
});
test('terminal tab description default exposes OSC progress without replacing the VS Code template',()=>{
 const manifest=require('../package.json');
 assert.equal(manifest.contributes.configurationDefaults['terminal.integrated.tabs.description'],'${task}${separator}${local}${separator}${cwdFolder}${separator}${progress}');
});
test('two ordinary terminal process trees remain distinct',()=>{
 const processes=parseProcesses(' 10 1 /bin/zsh\n 11 10 pi\n 20 1 /bin/zsh\n 21 20 codex\n 22 21 codex');
 assert.deepEqual([...descendants(10,processes)],[10,11]);
 assert.deepEqual([...descendants(20,processes)],[20,21,22]);
});
test('open session lock files retain the owning process identity',()=>{
 const files=parseOpenFiles('p11\nn/home/thread-writer-locks/a.lock\np21\nn/home/thread-writer-locks/b.lock');
 assert.deepEqual(files,[{pid:11,file:'/home/thread-writer-locks/a.lock'},{pid:21,file:'/home/thread-writer-locks/b.lock'}]);
});
test('Codex lifecycle reads exact task events incrementally without reading message bodies',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rekindle-codex-events-'));
 try {
  const file=path.join(dir,'rollout.jsonl');
  await fs.writeFile(file,JSON.stringify({type:'event_msg',payload:{type:'task_started',turn_id:'t1'}})+'\n');
  const initial=await readCodexLifecycle(file);
  assert.equal(initial.reset,true);
  assert.equal(initial.cursor.working,true);
  await fs.appendFile(file,JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:'t1',last_agent_message:'private'}})+'\n');
  const next=await readCodexLifecycle(file,initial.cursor);
  assert.equal(next.reset,false);
  assert.equal(next.cursor.working,false);
  assert.deepEqual(next.completions.map(event=>event.turnId),['t1'],'a task that starts and finishes between samples remains observable');
  await fs.appendFile(file,JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:'other'}})+'\n');
  const duplicate=await readCodexLifecycle(file,next.cursor);
  assert.equal(duplicate.cursor.working,false);
  await fs.appendFile(file,JSON.stringify({type:'event_msg',payload:{type:'task_started',turn_id:'t2'}})+'\n');
  const started=await readCodexLifecycle(file,duplicate.cursor);
  assert.equal(started.cursor.working,true);
  await fs.appendFile(file,JSON.stringify({type:'event_msg',payload:{type:'turn_aborted',turn_id:'t2',reason:'interrupted'}})+'\n');
  const aborted=await readCodexLifecycle(file,started.cursor);
  assert.equal(aborted.cursor.working,false,'interrupt events clear Working state');
 } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test('Codex lifecycle skips oversized records in bounded chunks and resumes after them',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rekindle-codex-large-'));
 try {
  const file=path.join(dir,'rollout.jsonl');
  await fs.writeFile(file,JSON.stringify({type:'session_meta',payload:{id:'thread'}})+'\n');
  const initial=await readCodexLifecycle(file,undefined,Date.now()+5000);
  const large=JSON.stringify({type:'event_msg',payload:{type:'task_started',turn_id:'large-turn',tool_output:'x'.repeat(300000)}})+'\n';
  const complete=JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:'large-turn',completed_at:1794330000}})+'\n';
  await fs.appendFile(file,large+complete);
  const part=await readCodexLifecycle(file,initial.cursor);
  assert.equal(part.cursor.working,true);
  const rest=await readCodexLifecycle(file,part.cursor);
  assert.equal(rest.cursor.working,false);
  assert.deepEqual(rest.completions.map(event=>event.turnId),['large-turn']);
 } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test('Codex startup scan suppresses old completion but reports a just-finished first sample',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rekindle-codex-baseline-'));
 try {
  const file=path.join(dir,'rollout.jsonl');
  const after=new Date(Date.now()+10).toISOString();
  await fs.writeFile(file,JSON.stringify({timestamp:after,type:'event_msg',payload:{type:'task_complete',turn_id:'fresh'}})+'\n');
  const recent=await readCodexLifecycle(file,undefined,Date.now());
  assert.deepEqual(recent.completions.map(event=>event.turnId),['fresh']);
  const old=await readCodexLifecycle(file,undefined,Date.now()+60000);
  assert.deepEqual(old.completions,[]);
 } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test('Codex startup baseline finds an active task older than a large output tail',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rekindle-codex-long-task-'));
 try {
  const file=path.join(dir,'rollout.jsonl');
  await fs.writeFile(file,JSON.stringify({type:'session_meta',payload:{id:'session',cwd:dir}})+'\n');
  await fs.appendFile(file,JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'task_started',turn_attribution:{kind:'user'},turn_id:'long-turn'}})+'\n');
  await fs.appendFile(file,JSON.stringify({type:'response_item',payload:{type:'tool_output',text:'x'.repeat(400000)}})+'\n');
  const result=await readCodexLifecycle(file,undefined,Date.now());
  assert.equal(result.reset,true);
  assert.equal(result.cursor.working,true,'the most recent task_started remains active even when output grows beyond the old 256KB reset tail');
  assert.equal(result.cursor.turnId,'long-turn');
  assert.deepEqual(result.completions,[],'cold-start baseline does not notify for historical work');
 } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test('shared Codex daemon uses only the bound managed rollout when terminal locks are ambiguous',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rekindle-codex-managed-'));
 try {
  const sessionId='01a1bf13-8898-7460-8645-1cc36a211432';
  const entryId='managed-entry';
  const sessionFile=path.join(dir,`rollout-${sessionId}.jsonl`);
  await fs.writeFile(sessionFile,[
   JSON.stringify({type:'session_meta',payload:{id:sessionId,cwd:dir}}),
   JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'task_started',turn_attribution:{kind:'user'},turn_id:'active-turn'}})
  ].join('\n')+'\n');
  const terminal={name:'Codex',processId:Promise.resolve(100),exitStatus:undefined,creationOptions:{env:{AGENT_SESSION_RESTORE_ID:entryId}}};
  const entry={id:entryId,provider:'codex',sessionId,sessionFile,cwd:dir,name:'Codex',enabled:true};
  const entries=[entry];
  const manager={entries,live:new Map([[entryId,terminal]]),working:new Set(),observe(session,target){this.observed=session;entry.automatic=true;this.live.set(entry.id,target);return {entry,dirty:false};},changed(){},save:async()=>{}};
  const terminalStates=[];
  const vscode={workspace:{isTrusted:true,getConfiguration:()=>({get:()=>false})},window:{terminals:[terminal],showInformationMessage(){}}};
  let includeCodex=true;
  const execFile=async command=>{
   if(command==='ps') return {stdout:includeCodex?'100 1 /bin/zsh\n101 100 /usr/local/bin/codex\n102 100 /usr/local/bin/codex\n':'100 1 /bin/zsh\n'};
   return {stdout:`p101\nn/home/thread-writer-locks/11111111-1111-4111-8111-111111111111.lock\np102\nn/home/thread-writer-locks/22222222-2222-4222-8222-222222222222.lock\n`};
  };
  const tracker=new AutomaticTracker(vscode,manager,()=>{},{platform:'darwin',testMode:true,registry:path.join(dir,'empty'),execFile,writeTerminalProgress:async(_terminal,working)=>{terminalStates.push(working);return true;}});
  await tracker.sample();
  assert.equal(manager.observed.sessionFile,sessionFile,'ambiguous locks do not replace the stored exact rollout');
  assert.equal(manager.working.has(entryId),true);
  assert.deepEqual(terminalStates,[true]);
  includeCodex=false;
  await tracker.sample();
  assert.equal(manager.working.has(entryId),false,'exiting the TUI clears task status even though the saved entry remains');
  assert.deepEqual(terminalStates,[true,false]);

  const mismatched={...entry,sessionId:'different-session',automatic:true};
  assert.equal(await readManagedCodexSession(mismatched,entryId,true),undefined,'session_meta id must match the exact saved session');
  assert.equal(await readManagedCodexSession(entry,undefined,true),undefined,'unbound terminals cannot use a managed session fallback');
  assert.equal(await readManagedCodexSession(entry,entryId,false),undefined,'an exited Codex process cannot inherit stale busy state');
 } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test('completion notification cursor suppresses startup and duplicate events without crossing sessions',()=>{
 const seen=new Map();
 assert.equal(consumeCompletion('a',99,seen,100),false,'old completion seeds historical state');
 assert.equal(consumeCompletion('a',99,seen,100),false,'repeated old Stop does not notify');
 assert.equal(consumeCompletion('a',101,seen,100),true,'a later first observed completion notifies');
 assert.equal(consumeCompletion('a',101,seen,100),false,'repeated event does not notify twice');
 assert.equal(consumeCompletion('b',100,seen,100),true,'same-sample first completion after tracker startup notifies');
 assert.equal(consumeCompletion('b',100,seen,100),false);
});
test('Pi bridge uses settled lifecycle and only emits a new token after a matching start',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rekindle-pi-bridge-'));
 const state=path.join(dir,'state');
 const previous=process.env.TERM_PROGRAM;
 try {
  process.env.TERM_PROGRAM='vscode';
  await installPiBridge(dir,state);
  const source=await fs.readFile(path.join(dir,'extensions/vscode-agent-session-restore.ts'),'utf8');
  const moduleFile=path.join(dir,'bridge.mjs');
  await fs.writeFile(moduleFile,stripTypeScriptTypes(source));
  const bridge=await import(pathToFileURL(moduleFile).href);
  const handlers={};
  bridge.default({on:(event,handler)=>handlers[event]=handler});
  let sessionId='pi-a';
  const sessionFile=path.join(dir,'session.jsonl');
  await fs.writeFile(sessionFile,JSON.stringify({type:'session',id:'pi-a',cwd:dir})+'\n');
  const ctx={cwd:dir,sessionManager:{getSessionFile:()=>sessionFile,getSessionId:()=>sessionId}};
  const read=async()=>JSON.parse(await fs.readFile(path.join(state,`${process.pid}.json`),'utf8'));
  handlers.session_start({},ctx);
  assert.equal((await read()).working,false);
  handlers.agent_start({},ctx);
  assert.equal((await read()).working,true);
  handlers.agent_settled({},ctx);
  const completed=await read();
  assert.equal(completed.working,false);
  assert.ok(completed.completedAt);
  handlers.agent_settled({},ctx);
  assert.equal((await read()).completedAt,completed.completedAt,'duplicate settle preserves the one-time completion token');
  sessionId='pi-b';
  await fs.writeFile(sessionFile,JSON.stringify({type:'session',id:'pi-b',cwd:dir})+'\n');
  handlers.agent_start({},ctx);
  const secondStart=await read();
  assert.equal(secondStart.completedAt,undefined,'session switch does not carry the previous completion token');
  handlers.agent_settled({},ctx);
  assert.ok((await read()).completedAt);
 } finally { if(previous===undefined) delete process.env.TERM_PROGRAM; else process.env.TERM_PROGRAM=previous; await fs.rm(dir,{recursive:true,force:true}); }
});
test('Pi bridge waits for first persisted header before reporting a new session as working',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rekindle-pi-deferred-'));
 const state=path.join(dir,'state');
 const previous=process.env.TERM_PROGRAM;
 try {
  process.env.TERM_PROGRAM='vscode';
  await installPiBridge(dir,state);
  const source=await fs.readFile(path.join(dir,'extensions/vscode-agent-session-restore.ts'),'utf8');
  const moduleFile=path.join(dir,'bridge.mjs');
  await fs.writeFile(moduleFile,stripTypeScriptTypes(source));
  const bridge=await import(pathToFileURL(moduleFile).href);
  const handlers={};
  bridge.default({on:(event,handler)=>handlers[event]=handler});
  const sessionFile=path.join(dir,'prospective-session.jsonl');
  const ctx={cwd:dir,sessionManager:{getSessionFile:()=>sessionFile,getSessionId:()=>'new-pi-session'}};
  const report=path.join(state,`${process.pid}.json`);
  handlers.session_start({},ctx);
  handlers.agent_start({},ctx);
  await assert.rejects(fs.stat(report),{code:'ENOENT'},'session_start and agent_start must not persist a path-only session');
  await fs.writeFile(sessionFile,JSON.stringify({type:'session',id:'new-pi-session',cwd:dir})+'\n');
  handlers.message_end({message:{role:'user',content:'must not enter registry'}},ctx);
  await new Promise(resolve=>setTimeout(resolve,15));
  const saved=JSON.parse(await fs.readFile(report,'utf8'));
  assert.equal(saved.sessionId,'new-pi-session');
  assert.equal(saved.working,true,'the deferred durable report retains the active task state');
  assert.equal(JSON.stringify(saved).includes('must not enter registry'),false,'the hook stores metadata only');
 } finally { if(previous===undefined) delete process.env.TERM_PROGRAM; else process.env.TERM_PROGRAM=previous; await fs.rm(dir,{recursive:true,force:true}); }
});
test('startup prepares provider hooks before restore and reuses the prepared bridge',async()=>{
 const order=[];
 const tracker=new AutomaticTracker({}, {}, message=>order.push(`log:${message}`), {
  platform:'darwin',
  installPiBridge:async()=>order.push('pi-hooks'),
  installAgentBridges:async()=>order.push('provider-hooks')
 });
 await tracker.restoreAfterPrepare(async()=>order.push('restore-cli'));
 await tracker.prepare();
 assert.deepEqual(order,['pi-hooks','provider-hooks','restore-cli']);
 const isolated=[];
 const testTracker=new AutomaticTracker({}, {}, ()=>{}, {
  platform:'darwin',testMode:true,
  installPiBridge:async()=>isolated.push('pi'),installAgentBridges:async()=>isolated.push('providers')
 });
 await testTracker.restoreAfterPrepare(async()=>isolated.push('restore'));
 assert.deepEqual(isolated,['restore'],'test mode does not write to user home directories');
});

test('tracked task state reaches only its terminal tty and close clears the mapping',async()=>{
 const writes=[];
 const handles=[];
 const charDevice={isCharacterDevice:()=>true,uid:typeof process.getuid==='function'?process.getuid():0};
 const io={
  stat:async()=>charDevice,
  open:async device=>{
   writes.push({device,sequence:''});
   const row=writes[writes.length-1];
   const handle={stat:async()=>charDevice,write:async sequence=>{row.sequence+=sequence;},close:async()=>{}};
   handles.push(handle);
   return handle;
  }
 };
 const terminal={processId:321,exitStatus:undefined,creationOptions:{env:{}}};
 const {writeTerminalProgress}=require('../src/terminal-progress');
 const execFile=async (_cmd,args)=>({stdout:args[3]==='321'?'ttys004\n':''});
 const terminals=[terminal];
 const transitions=[];
 const tracker=new AutomaticTracker({window:{terminals}}, {entries:[],live:new Map()}, ()=>{}, {platform:'darwin',writeTerminalProgress:async(target,working)=>{transitions.push({target,working});return true;}});
 await tracker.updateTerminalProgress(terminal,true,321);
 await tracker.updateTerminalProgress(terminal,true,321);
 await tracker.updateTerminalProgress(terminal,false,321);
 assert.deepEqual(transitions.map(row=>row.working),[true,false],'repeated samples do not rewrite progress');
 await tracker.updateTerminalProgress(terminal,true,321);
 tracker.closed(terminal);
 assert.equal(tracker.terminalProgress.has(terminal),false,'closed terminal state is discarded');
 const idleTerminal={processId:322,exitStatus:undefined}; terminals.push(idleTerminal);
 await tracker.updateTerminalProgress(idleTerminal,false,322);
 await tracker.updateTerminalProgress(idleTerminal,false,322);
 assert.equal(tracker.terminalProgress.get(idleTerminal),false,'idle is retained as a known progress state');
 assert.equal(transitions.filter(row=>row.target===idleTerminal).length,1,'unknown to idle clears once and repeated idle is deduplicated');
 const afterReload=[];
 const reloaded=new AutomaticTracker({window:{terminals}}, {entries:[],live:new Map()}, ()=>{}, {platform:'darwin',writeTerminalProgress:async(target,working)=>{afterReload.push({target,working});return true;}});
 await reloaded.updateTerminalProgress(terminal,false,321);
 await reloaded.updateTerminalProgress(terminal,false,321);
 assert.deepEqual(afterReload.map(row=>row.working),[false],'a fresh tracker clears prior busy state when its first sample sees idle');
 await writeTerminalProgress(terminal,true,{platform:'darwin',terminals,fs:io,execFile});
 await writeTerminalProgress(terminal,false,{platform:'darwin',terminals,fs:io,execFile});
 assert.deepEqual(writes,[
  {device:'/dev/ttys004',sequence:'\u001b]9;4;3\u0007'},
  {device:'/dev/ttys004',sequence:'\u001b]9;4;0\u0007'}
 ]);
});

test('terminal progress refuses foreign, non-terminal, exited, and non-macOS targets',async()=>{
 const {writeTerminalProgress}=require('../src/terminal-progress');
 let opened=0;
 const fs={stat:async()=>({isCharacterDevice:()=>true,uid:process.getuid?.()??0}),open:async()=>{opened++;throw new Error('should not open');}};
 const terminal={processId:42,exitStatus:undefined};
 const execFile=async()=>({stdout:'ttys004\n'});
 assert.equal(await writeTerminalProgress(terminal,true,{platform:'linux',terminals:[terminal],fs,execFile}),false);
 assert.equal(await writeTerminalProgress(terminal,true,{platform:'darwin',terminals:[],fs,execFile}),false);
 terminal.exitStatus={code:0};
 assert.equal(await writeTerminalProgress(terminal,true,{platform:'darwin',terminals:[terminal],fs,execFile}),false);
 terminal.exitStatus=undefined;
 const foreignFs={stat:async()=>({isCharacterDevice:()=>true,uid:(process.getuid?.()??0)+1}),open:async()=>{opened++;throw new Error('should not open');}};
 assert.equal(await writeTerminalProgress(terminal,true,{platform:'darwin',terminals:[terminal],fs:foreignFs,execFile}),false);
 assert.equal(opened,0);
});

test('unidentifiable live agent is Unknown, never idle or a completion, and clears stale tab progress',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rekindle-unknown-state-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const registry=path.join(dir,'registry');await fs.mkdir(registry);
 const entry={id:'pi-entry',provider:'pi',sessionId:'pi-session',cwd:dir,name:'pi task',automatic:true,enabled:true};
 const terminal={processId:Promise.resolve(100),creationOptions:{env:{AGENT_SESSION_RESTORE_ID:entry.id}}};
 await fs.writeFile(path.join(registry,'101.json'),JSON.stringify({pid:101,provider:'pi',sessionId:entry.sessionId,cwd:dir,sessionFile:path.join(dir,'pi.jsonl')}));
 const writes=[],messages=[];
 const manager={entries:[entry],live:new Map([[entry.id,terminal]]),working:new Set([entry.id]),status:new Map(),observe(session,target){return {entry,dirty:false};},changed(){},save:async()=>{}};
 const vscode={workspace:{isTrusted:true,getConfiguration:()=>({get:(key,fallback)=>fallback})},window:{terminals:[terminal],showInformationMessage:message=>{messages.push(message);return Promise.resolve();}}};
 const tracker=new AutomaticTracker(vscode,manager,()=>{},{registry,execFile:async()=>({stdout:'100 1 /bin/zsh\n101 100 /usr/local/bin/pi\n'}),writeTerminalProgress:async(_terminal,working)=>{writes.push(working);return true;}});
 tracker.terminalIds.set(terminal,entry.id);
 await tracker.sample();
 assert.equal(manager.status.get(entry.id).state,'unknown');
 assert.equal(manager.working.has(entry.id),false);
 assert.deepEqual(messages,[]);
 assert.equal(writes.at(-1),false);
});
