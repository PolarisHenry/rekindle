'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { installAgentBridges } = require('../src/bridges');
const { normalize, owningProcess, completionTimestamp } = require('../src/session-hook.cjs');
const { resumeArguments } = require('../src/core');
const { unusedShell, removeStartupShells } = require('../src/startup');

test('Claude and AGY restore exact conversations with provider-specific flags', () => {
  assert.deepEqual(resumeArguments({ provider: 'claude', sessionId: 'claude-id' }), ['--resume', 'claude-id']);
  assert.deepEqual(resumeArguments({ provider: 'agy', sessionId: 'agy-id' }), ['--conversation', 'agy-id']);
});

test('provider hook payloads retain only session metadata, not prompts or tool inputs', () => {
  const claude = normalize('claude', { session_id: 'a', cwd: '/workspace', transcript_path: '/a.jsonl', prompt: 'private input', tool_input: {} });
  const agy = normalize('agy', { conversationId: 'b', workspacePaths: ['/workspace'], transcriptPath: '/b.jsonl', lastUserInput: 'private input' });
  assert.deepEqual(claude, { provider: 'claude', sessionId: 'a', cwd: '/workspace', sessionFile: '/a.jsonl' });
  assert.equal(agy.sessionId, 'b');
  assert.equal('lastUserInput' in agy, false);
  assert.equal(normalize('claude', { session_id: 'sub', cwd: '/workspace', agent_id: 'nested' }), null);
});

test('supported provider lifecycle hooks report only working state and metadata', () => {
  assert.equal(normalize('claude', { session_id:'c', cwd:'/work', hook_event_name:'UserPromptSubmit', prompt:'secret' }).working, true);
  assert.equal(normalize('claude', { session_id:'c', cwd:'/work', hook_event_name:'Stop' }).working, false);
  assert.equal(normalize('agy', { conversationId:'g', workspacePaths:['/work'] }, 'PreInvocation').working, true);
  assert.equal(normalize('agy', { conversationId:'g', workspacePaths:['/work'], lastUserInput:'secret' }, 'Stop').working, false);
});

test('hook completion tokens require a matching observed start and ignore duplicate stop', () => {
  const start={provider:'claude',sessionId:'c',working:true};
  const stop={provider:'claude',sessionId:'c',working:false,completionSignal:true};
  assert.equal(completionTimestamp(undefined,stop,10),undefined,'startup with an old stop does not create a token');
  assert.equal(completionTimestamp(start,stop,10),10);
  assert.equal(completionTimestamp({...start,working:false,completedAt:10},stop,11),10,'a repeated Stop does not bump completion token');
  assert.equal(completionTimestamp({...start,working:false,completedAt:10},{provider:'claude',sessionId:'next',working:true},12),undefined,'a new session start discards the previous session token');
  assert.equal(completionTimestamp({...start,sessionId:'other',working:false,completedAt:10},{...stop,sessionId:'next'},12),undefined,'a previous conversation token is discarded when this process switches sessions');
});

test('real hook runner emits one activity and completion token for a prompt/Stop pair', async t => {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'rekindle-hook-runtime-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const bin=path.join(home,'bin');
  await fs.mkdir(bin);
  const ps=path.join(bin,'ps');
  await fs.writeFile(ps,'#!/bin/sh\nprintf "%s\\n" "${REKINDLE_TEST_PARENT_PID} 1 /bin/claude"\n',{mode:0o755});
  const target=path.join(home,'.local/state/vscode-agent-session-restore/pi',`${process.pid}.json`);
  const emit=(event)=>{
    const result=spawnSync(process.execPath,[path.join(__dirname,'../src/session-hook.cjs'),'claude',event],{
      input:JSON.stringify({session_id:'hook-session',cwd:home,prompt:'never persist this'}),encoding:'utf8',
      env:{...process.env,HOME:home,TERM_PROGRAM:'vscode',PATH:`${bin}:${process.env.PATH}`,REKINDLE_TEST_PARENT_PID:String(process.pid)}
    });
    assert.equal(result.status,0,result.stderr);
  };
  emit('UserPromptSubmit');
  const started=JSON.parse(await fs.readFile(target,'utf8'));
  emit('Stop');
  const stopped=JSON.parse(await fs.readFile(target,'utf8'));
  assert.equal(stopped.working,false);
  assert.ok(stopped.completedAt>0);
  assert.ok(stopped.activityAt>=started.activityAt);
  emit('Stop');
  const repeated=JSON.parse(await fs.readFile(target,'utf8'));
  assert.equal(repeated.completedAt,stopped.completedAt,'duplicate Stop does not create a completion token');
  assert.equal(repeated.activityAt,stopped.activityAt,'duplicate Stop does not bump task activity');
  assert.equal(JSON.stringify(repeated).includes('never persist'),false);
});

test('hook process ancestry cannot associate another terminal with a session', () => {
  const processes = '1 0 init\n10 1 /bin/zsh\n11 10 /bin/claude\n12 11 /bin/sh\n20 1 /bin/agy\n21 20 /bin/sh';
  assert.equal(owningProcess(12, processes, 'claude'), 11);
  assert.equal(owningProcess(21, processes, 'agy'), 20);
  assert.equal(owningProcess(12, processes, 'agy'), null);
});

test('bridge installation preserves existing hooks and stays idempotent', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-hooks-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ model: 'keep-me', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } }));
  await installAgentBridges(home);
  await installAgentBridges(home);
  const claude = JSON.parse(await fs.readFile(path.join(home, '.claude/settings.json')));
  assert.equal(claude.model, 'keep-me');
  assert.equal(claude.hooks.SessionStart.length, 2);
  assert.equal(claude.hooks.SessionStart[0].hooks[0].command, 'echo existing');
  const agy = JSON.parse(await fs.readFile(path.join(home, '.gemini/config/hooks.json')));
  assert.ok(agy.rekindle.SessionStart[0].command.endsWith(' agy SessionStart'));
  assert.ok(agy.rekindle.PreInvocation[0].command.endsWith(' agy PreInvocation'));
  assert.ok(agy.rekindle.Stop[0].command.endsWith(' agy Stop'));
});

test('only an untouched default shell is eligible for startup cleanup', () => {
  const shell = { name: 'zsh', state: { isInteractedWith: false }, creationOptions: {} };
  assert.equal(unusedShell(shell), true);
  assert.equal(unusedShell({ ...shell, state: { isInteractedWith: true } }), false);
  assert.equal(unusedShell({ ...shell, name: 'My shell' }), false);
  assert.equal(unusedShell({ ...shell, creationOptions: { env: { AGENT_SESSION_RESTORE_ID: 'keep' } } }), false);
});

test('no restored agent means default shell is retained', async () => {
  let disposed = false;
  const shell = { dispose() { disposed = true; } };
  await removeStartupShells({}, { entries: [], live: new Map() }, [shell], () => {});
  assert.equal(disposed, false);
});
