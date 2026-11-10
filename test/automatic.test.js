'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {stripTypeScriptTypes}=require('node:module');
const {AutomaticTracker,descendants,parseProcesses,parseOpenFiles,readCodexLifecycle,consumeCompletion,installPiBridge}=require('../src/automatic');
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
  const ctx={cwd:dir,sessionManager:{getSessionFile:()=>path.join(dir,'session.jsonl'),getSessionId:()=>sessionId}};
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
  handlers.agent_start({},ctx);
  const secondStart=await read();
  assert.equal(secondStart.completedAt,undefined,'session switch does not carry the previous completion token');
  handlers.agent_settled({},ctx);
  assert.ok((await read()).completedAt);
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
