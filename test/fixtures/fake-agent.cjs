'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const data = process.env.AGENT_RESTORE_TEST_DATA;
const args = process.argv.slice(2);
if (args[0] === 'capture') {
  process.title = 'codex';
  const id = args[1];
  const base = path.join(data, 'codex');
  fs.mkdirSync(path.join(base, 'thread-writer-locks'), { recursive: true });
  fs.mkdirSync(path.join(base, 'sessions'), { recursive: true });
  fs.openSync(path.join(base, 'thread-writer-locks', `${id}.lock`), 'w');
  const rollout = path.join(base, 'sessions', `rollout-${id}.jsonl`);
  fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id, cwd: process.cwd() } }) + '\n');
  fs.openSync(rollout, 'r');
}
if (args[0] === 'hook') {
  const provider = args[1];
  const sessionId = args[2];
  process.title = provider;
  const payload = provider === 'agy'
    ? { conversationId: sessionId, workspacePaths: [process.cwd()], transcriptPath: path.join(data, 'agy.jsonl') }
    : { session_id: sessionId, cwd: process.cwd(), transcript_path: path.join(data, 'claude.jsonl') };
  execFileSync(process.execPath, [path.join(__dirname, '../../src/session-hook.cjs'), provider], {
    input: JSON.stringify(payload),
    env: { ...process.env, TERM_PROGRAM: 'vscode' }
  });
}
fs.appendFileSync(path.join(data, 'launches.jsonl'), JSON.stringify({ args, cwd: process.cwd(), id: process.env.AGENT_SESSION_RESTORE_ID }) + '\n');
setInterval(() => {}, 1000);
