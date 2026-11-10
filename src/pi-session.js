'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_FILES = 20000;
const MAX_DEPTH = 8;

function expandHome(value) {
  return value === '~' ? os.homedir() : value?.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function piSessionsRoot(config = {}) {
  if (config.piHome) return path.join(expandHome(config.piHome), 'sessions');
  return process.env.PI_CODING_AGENT_SESSION_DIR
    || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions');
}

async function readHeader(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) return undefined;
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_HEADER_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) return undefined;
    const row = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
    return row?.type === 'session' && typeof row.id === 'string' && typeof row.cwd === 'string' && path.isAbsolute(row.cwd)
      ? row
      : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sameCwd(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && path.isAbsolute(left) && path.isAbsolute(right)
    && path.resolve(left) === path.resolve(right);
}

async function isExactSessionFile(file, sessionId, cwd) {
  const header = await readHeader(file);
  return header?.id === sessionId && sameCwd(header.cwd, cwd);
}

async function collectJsonl(root, { depth = MAX_DEPTH, remaining = MAX_FILES } = {}) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []; throw error; }
  const files = [];
  for (const item of entries) {
    if (files.length >= remaining) break;
    const file = path.join(root, item.name);
    if (item.isFile() && item.name.endsWith('.jsonl')) files.push(file);
    else if (item.isDirectory() && depth > 0) {
      files.push(...await collectJsonl(file, { depth: depth - 1, remaining: remaining - files.length }));
    }
  }
  return files;
}

/** Resolve only by exact pi JSONL header id and cwd; never by recency or filename alone. */
async function resolvePiSessionFile({ sessionId, cwd, sessionFile, sessionRoot } = {}) {
  if (typeof sessionId !== 'string' || !sessionId || !path.isAbsolute(cwd || '')) return undefined;
  if (path.isAbsolute(sessionFile || '') && await isExactSessionFile(sessionFile, sessionId, cwd)) return sessionFile;

  if (!path.isAbsolute(sessionRoot || '')) return undefined;
  const files = await collectJsonl(sessionRoot);
  const ordered = [...files.filter(file => path.basename(file).includes(sessionId)), ...files.filter(file => !path.basename(file).includes(sessionId))];
  const matches = [];
  for (const file of ordered) {
    if (await isExactSessionFile(file, sessionId, cwd)) {
      matches.push(file);
      if (matches.length > 1) return undefined;
    }
  }
  return matches[0];
}

module.exports = { piSessionsRoot, readHeader, resolvePiSessionFile };
