'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFileDefault = promisify(require('node:child_process').execFile);

async function resolveTerminalTty(pid, options = {}) {
  if (options.platform !== 'darwin' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const execFile = options.execFile || execFileDefault;
  try {
    const { stdout } = await execFile('/bin/ps', ['-o', 'tty=', '-p', String(pid)], { timeout: 2000 });
    const tty = stdout.trim();
    if (!/^ttys[A-Za-z0-9]+$/.test(tty)) return undefined;
    const device = path.join('/dev', tty);
    const stats = await (options.fs || fs).stat(device);
    if (!stats.isCharacterDevice()) return undefined;
    if (typeof process.getuid === 'function' && stats.uid !== 0 && stats.uid !== process.getuid()) return undefined;
    return device;
  } catch {
    return undefined;
  }
}

async function writeTerminalProgress(terminal, working, options = {}) {
  const terminals = options.terminals;
  if (options.platform !== 'darwin' || !terminal || !Array.isArray(terminals) || !terminals.includes(terminal) || terminal.exitStatus !== undefined) return false;
  const pid = await Promise.resolve(terminal.processId).catch(() => undefined);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !terminals.includes(terminal) || terminal.exitStatus !== undefined) return false;
  const device = await resolveTerminalTty(pid, options);
  if (!device || !terminals.includes(terminal) || terminal.exitStatus !== undefined) return false;
  let handle;
  try {
    const io = options.fs || fs;
    const expected = await io.stat(device);
    if (!expected.isCharacterDevice()) return false;
    handle = await io.open(device, constants.O_WRONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NOCTTY || 0));
    const stats = await handle.stat();
    if (!stats.isCharacterDevice()) return false;
    if ((expected.dev !== undefined && stats.dev !== expected.dev) || (expected.ino !== undefined && stats.ino !== expected.ino)) return false;
    if (typeof process.getuid === 'function' && stats.uid !== 0 && stats.uid !== process.getuid()) return false;
    if (!terminals.includes(terminal) || terminal.exitStatus !== undefined || await Promise.resolve(terminal.processId).catch(() => undefined) !== pid) return false;
    const sequence = working ? '\u001b]9;4;3\u0007' : '\u001b]9;4;0\u0007';
    await handle.write(sequence);
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

module.exports = { resolveTerminalTty, writeTerminalProgress };
