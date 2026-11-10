'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolvePiSessionFile } = require('../src/pi-session');

async function writeSession(file, id, cwd) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ type: 'session', id, cwd }) + '\n');
}

test('pi session resolver finds a renamed file only when header ID and cwd match', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-pi-resolve-'));
  const cwd = path.join(root, 'project');
  const sessions = path.join(root, 'sessions');
  const moved = path.join(sessions, 'renamed', 'conversation.jsonl');
  const missingPath = path.join(sessions, 'old-name.jsonl');
  try {
    await fs.mkdir(cwd);
    await writeSession(moved, 'exact-id', cwd);
    await writeSession(path.join(sessions, 'recent.jsonl'), 'other-id', cwd);
    assert.equal(await resolvePiSessionFile({
      sessionId: 'exact-id', cwd, sessionFile: missingPath, sessionRoot: sessions
    }), moved);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('pi session resolver refuses mismatched cwd, mismatched header ID, and ambiguous duplicates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-pi-reject-'));
  const cwd = path.join(root, 'project');
  const sessions = path.join(root, 'sessions');
  try {
    await fs.mkdir(cwd);
    await writeSession(path.join(sessions, 'wrong-cwd.jsonl'), 'target-id', root);
    await writeSession(path.join(sessions, 'wrong-id.jsonl'), 'different-id', cwd);
    assert.equal(await resolvePiSessionFile({ sessionId: 'target-id', cwd, sessionRoot: sessions }), undefined);
    assert.equal(await resolvePiSessionFile({ sessionId: 'absent', cwd, sessionRoot: sessions }), undefined);

    await writeSession(path.join(sessions, 'first-valid.jsonl'), 'target-id', cwd);
    await writeSession(path.join(sessions, 'duplicate.jsonl'), 'target-id', cwd);
    assert.equal(await resolvePiSessionFile({ sessionId: 'target-id', cwd, sessionRoot: sessions }), undefined,
      'duplicate exact IDs are ambiguous and are not selected by recency');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('pi session resolver accepts a direct saved path only after checking its metadata header', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-pi-direct-'));
  const cwd = path.join(root, 'project');
  const file = path.join(root, 'session.jsonl');
  try {
    await fs.mkdir(cwd);
    await writeSession(file, 'right-id', cwd);
    assert.equal(await resolvePiSessionFile({ sessionId: 'right-id', cwd, sessionFile: file }), file);
    assert.equal(await resolvePiSessionFile({ sessionId: 'wrong-id', cwd, sessionFile: file }), undefined);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
