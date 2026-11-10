'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { discoverSessions, resumeArguments, resumeCommand, launchOptions, isInWorkspace, resolveTargetFolder, dispatchFolderAdd } = require('../src/core');

test('resume is bound to exact IDs, never the most recent conversation', () => {
  assert.deepEqual(resumeArguments({ provider: 'codex', sessionId: 'specific-id' }), ['resume', 'specific-id']);
  assert.deepEqual(resumeArguments({ provider: 'pi', sessionId: 'pi-id', sessionFile: '/my/session.jsonl' }), ['--session', '/my/session.jsonl']);
  assert.throws(() => resumeArguments({ provider: 'unknown', sessionId: 'id' }));
});

test('provider arguments precede exact resume arguments on every launch path', () => {
  const cases = [
    ['codex', ['--yolo'], ['resume', 'exact-id']],
    ['agy', ['--dangerously-skip-permissions'], ['--conversation', 'exact-id']],
    ['claude', ['--dangerously-skip-permissions'], ['--resume', 'exact-id']],
    ['pi', ['--model', 'model with spaces'], ['--session', 'exact-id']]
  ];
  for (const [provider, extra, resume] of cases) {
    const session = { provider, sessionId: 'exact-id', name: 'Agent', cwd: '/project' };
    const config = { [`${provider}Arguments`]: extra };
    assert.deepEqual(resumeArguments(session, config), [...extra, ...resume]);
    assert.deepEqual(launchOptions(session, config, 'win32').shellArgs, [...extra, ...resume]);
  }
  for (const invalid of ['--yolo', [null], [1], ['bad\nargument'], ['bad\0argument']]) {
    assert.throws(() => resumeCommand({ provider: 'codex', sessionId: 'exact-id' }, { codexArguments: invalid }), /array of single-line strings/);
  }
});

test('configured arguments preserve spaces and shell metacharacters as literal values', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-args-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'capture');
  await fs.writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const extra = ['--model', "value ' $(touch INJECTED) `touch INJECTED`", '', '; touch INJECTED'];
  const command = resumeCommand({ provider: 'codex', sessionId: 'exact-id' }, { codexCommand: executable, codexArguments: extra });
  const stdout = execFileSync('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8' });
  assert.equal(stdout, [...extra, 'resume', 'exact-id', ''].join('\n'));
  await assert.rejects(fs.stat(path.join(root, 'INJECTED')), { code: 'ENOENT' });
});

test('login-shell arguments cannot execute substitutions from executable or session paths', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-quote-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "cli ' $(touch INJECTED)");
  await fs.writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const input = { id: 'record', name: 'test', cwd: root, provider: 'pi', sessionId: 'id', sessionFile: "file ' $(touch INJECTED) `touch INJECTED`" };
  const options = launchOptions(input, { piCommand: executable }, 'darwin');
  const stdout = execFileSync('/bin/sh', ['-c', resumeCommand(input, { piCommand: executable })], { cwd: root, encoding: 'utf8' });
  assert.equal(stdout, `--session\n${input.sessionFile}\n`);
  await assert.rejects(fs.stat(path.join(root, 'INJECTED')), { code: 'ENOENT' });
  assert.equal(options.isTransient, true);
  assert.equal(options.shellPath, undefined);
  assert.equal(options.shellArgs, undefined);
  assert.equal(options.env.AGENT_SESSION_RESTORE_ID, 'record');
});

test('discovery keeps different pi sessions in the same directory distinct and reads names', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-pi-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, 'sessions', '--project--');
  await fs.mkdir(dir, { recursive: true });
  for (const id of ['one', 'two']) await fs.writeFile(path.join(dir, `${id}.jsonl`), [
    JSON.stringify({ type: 'session', id, cwd: '/project', timestamp: new Date().toISOString() }),
    JSON.stringify({ type: 'session_info', name: `name ${id}` })
  ].join('\n'));
  await fs.writeFile(path.join(dir, 'partial.jsonl'), '{');
  const sessions = await discoverSessions('pi', { piHome: home });
  assert.deepEqual(sessions.map(item => item.sessionId).sort(), ['one', 'two']);
  assert.deepEqual(sessions.map(item => item.title).sort(), ['name one', 'name two']);
});

test('legacy Codex rollout and title index work without SQLite', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-codex-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, 'sessions/2026/11/09');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'rollout.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'codex-id', cwd: '/project' } }) + '\n');
  await fs.writeFile(path.join(home, 'session_index.jsonl'), JSON.stringify({ id: 'codex-id', thread_name: '库存核对' }) + '\n');
  const sessions = await discoverSessions('codex', { codexHome: home });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, '库存核对');
  assert.equal(sessions[0].sessionId, 'codex-id');
});

test('workspace filtering honors path boundaries', () => {
  assert.equal(isInWorkspace('/project/sub', ['/project']), true);
  assert.equal(isInWorkspace('/project-other', ['/project']), false);
});

test('folder context targets resolve from sidebar group, Explorer URI, and paths', () => {
  assert.equal(resolveTargetFolder({kind:'folder',cwd:'/work/sub'}),'/work/sub');
  assert.equal(resolveTargetFolder({fsPath:'/work/explorer'}),'/work/explorer');
  assert.equal(resolveTargetFolder({uri:{fsPath:'/work/uri'}}),'/work/uri');
  assert.equal(resolveTargetFolder('/work/path'),'/work/path');
});

test('folder action forwards a sidebar folder group cwd into Add Session', async () => {
  const calls=[];
  await dispatchFolderAdd({kind:'folder',cwd:'/workspace/sub'},(...args)=>calls.push(args));
  assert.deepEqual(calls,[['agentSessionRestore.add','/workspace/sub']]);
});

test('Codex paginated history is discoverable from its read-only SQLite index', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-codex-db-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const db = path.join(home, 'state_5.sqlite');
  execFileSync('sqlite3', [db, `CREATE TABLE threads(id TEXT, cwd TEXT, title TEXT, rollout_path TEXT, updated_at INTEGER, archived INTEGER, has_user_event INTEGER);
    INSERT INTO threads VALUES('paged-id', '/project', '分页对话', '/missing/rollout.jsonl', 123, 0, 1);
    INSERT INTO threads VALUES('archived-id', '/project', 'archived', '', 124, 1, 1);`]);
  const sessions = await discoverSessions('codex', { codexHome: home });
  assert.deepEqual(sessions.map(item => item.sessionId), ['paged-id']);
  assert.equal(sessions[0].title, '分页对话');
});

test('Claude history reads session IDs, folder metadata and custom titles', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-claude-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, 'projects', '-workspace');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'claude-id.jsonl'), [
    { type: 'last-prompt', sessionId: 'claude-id' },
    { type: 'user', sessionId: 'claude-id', cwd: '/workspace', message: { content: 'First question' } },
    { type: 'custom-title', customTitle: 'Named conversation' }
  ].map(JSON.stringify).join('\n'));
  const sessions = await discoverSessions('claude', { claudeHome: home });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'claude-id');
  assert.equal(sessions[0].title, 'Named conversation');
});

test('AGY history reads root conversations and decodes workspace file URIs', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-agy-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  execFileSync('sqlite3', [path.join(home, 'conversation_summaries.db'), `CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,workspace_uris TEXT,last_modified_time TEXT,parent_conversation_id TEXT);
    INSERT INTO conversation_summaries VALUES('agy-id','AGY history','["file:///work/my%20project"]','2026-11-09','');
    INSERT INTO conversation_summaries VALUES('nested','Subagent','["file:///work"]','2026-11-09','agy-id');`]);
  const sessions = await discoverSessions('agy', { agyHome: home });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'agy-id');
  assert.equal(sessions[0].cwd, '/work/my project');
});
