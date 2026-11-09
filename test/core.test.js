'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { discoverSessions, resumeArguments, resumeCommand, launchOptions, isInWorkspace } = require('../src/core');

test('resume is bound to exact IDs, never the most recent conversation', () => {
  assert.deepEqual(resumeArguments({ provider: 'codex', sessionId: 'specific-id' }), ['resume', 'specific-id']);
  assert.deepEqual(resumeArguments({ provider: 'pi', sessionId: 'pi-id', sessionFile: '/my/session.jsonl' }), ['--session', '/my/session.jsonl']);
  assert.throws(() => resumeArguments({ provider: 'unknown', sessionId: 'id' }));
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
