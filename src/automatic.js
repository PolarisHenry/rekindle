'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { installAgentBridges } = require('./bridges');
const { writeTerminalProgress } = require('./terminal-progress');
const { notificationTargets } = require('./completion-notifications');

const registry = path.join(os.homedir(), '.local/state/vscode-agent-session-restore/pi');

function completionSummary(name) {
  let text = '', width = 0;
  const full = String(name || 'Session').replace(/[\r\n\t]/g, ' ');
  for (const char of full) {
    const size = char.codePointAt(0) > 0x7f ? 2 : 1;
    if (width + size > 12) return text + '…';
    text += char; width += size;
  }
  return text;
}

function descendants(pid, processes) {
  const result = new Set([pid]);
  let changed;
  do {
    changed = false;
    for (const p of processes) if (result.has(p.parent) && !result.has(p.pid)) { result.add(p.pid); changed = true; }
  } while (changed);
  return result;
}

function parseProcesses(text) {
  return text.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : [];
  });
}

function parseOpenFiles(text) {
  const records = [];
  let pid;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line.startsWith('n') && pid) records.push({ pid, file: line.slice(1) });
  }
  return records;
}

// A CLI may invoke another agent as a tool. Only the outermost agent owns the
// terminal; reports from nested agents must never replace that conversation.
function terminalAgent(pid, processes) {
  const children = descendants(pid, processes);
  const agents = processes.filter(row => children.has(row.pid) && /(?:^|\/)(?:pi|codex|claude|agy)$/.test(row.command));
  const byPid = new Map(processes.map(row => [row.pid, row]));
  const agentIds = new Set(agents.map(row => row.pid));
  const roots = agents.filter(row => {
    if (row.pid !== pid && agentIds.has(pid)) return false;
    const seen = new Set();
    let parent = row.parent;
    while (parent && parent !== pid && !seen.has(parent)) {
      if (agentIds.has(parent)) return false;
      seen.add(parent);
      parent = byPid.get(parent)?.parent;
    }
    return true;
  });
  const providers = new Set(roots.map(root => path.basename(root.command)));
  if (providers.size !== 1) return { children: new Set(), present: agents.length > 0, ambiguous: agents.length > 0, rootPids: roots.map(root => root.pid) };
  const provider = [...providers][0];
  const owned = new Set(roots.flatMap(root => [...descendants(root.pid, processes)]));
  // Exclude foreign-agent subtrees, even if they launch the outer provider again.
  for (const agent of agents) if (owned.has(agent.pid) && path.basename(agent.command) !== provider) {
    for (const nested of descendants(agent.pid, processes)) owned.delete(nested);
  }
  return { provider, children: owned, present: true, rootPids: roots.map(root => root.pid) };
}

function normalizeActivity(value) {
  const n = typeof value === 'string' ? Date.parse(value) : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

function skipJsonString(text, index) {
  for (let i = index + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '"') return i + 1;
  }
  return undefined;
}

function skipJsonValue(text, index) {
  const first = text[index];
  if (first === '"') return skipJsonString(text, index);
  if (first !== '{' && first !== '[') {
    let i = index;
    while (i < text.length && !',}]'.includes(text[i])) i++;
    return i;
  }
  const stack = [first === '{' ? '}' : ']'];
  for (let i = index + 1; i < text.length; i++) {
    if (text[i] === '"') { const end = skipJsonString(text, i); if (!end) return undefined; i = end - 1; continue; }
    if (text[i] === '{') stack.push('}');
    else if (text[i] === '[') stack.push(']');
    else if (text[i] === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i + 1; }
  }
  return undefined;
}

function readJsonString(text, index) {
  const end = skipJsonString(text, index);
  if (!end) return undefined;
  try { return { value: JSON.parse(text.slice(index, end)), end }; } catch { return undefined; }
}

function readCodexMetadataObject(text, start, wanted, payloadWanted = []) {
  if (text[start] !== '{') return undefined;
  const result = {};
  let index = start + 1;
  while (index < text.length) {
    while (/\s/.test(text[index] || '')) index++;
    if (text[index] === '}') return { value: result, end: index + 1 };
    const key = readJsonString(text, index);
    if (!key) return { value: result, end: undefined };
    index = key.end;
    while (/\s/.test(text[index] || '')) index++;
    if (text[index] !== ':') return { value: result, end: undefined };
    index++;
    while (/\s/.test(text[index] || '')) index++;
    const valueStart = index;
    if (key.value === 'payload' && payloadWanted.length && text[index] === '{') {
      const nested = readCodexMetadataObject(text, index, new Set(payloadWanted));
      result.payload = nested?.value;
      index = nested?.end ?? text.length;
    } else if (wanted.has(key.value)) {
      if (text[index] === '"') {
        const token = readJsonString(text, index);
        if (!token) return { value: result, end: undefined };
        result[key.value] = token.value;
        index = token.end;
      } else {
        const end = skipJsonValue(text, index);
        if (end === undefined) return { value: result, end: undefined };
        const raw = text.slice(index, end).trim();
        result[key.value] = raw === 'null' ? undefined : Number.isFinite(Number(raw)) && raw !== '' ? Number(raw) : undefined;
        index = end;
      }
    } else {
      const end = skipJsonValue(text, valueStart);
      if (end === undefined) return { value: result, end: undefined };
      index = end;
    }
    while (/\s/.test(text[index] || '')) index++;
    if (text[index] === ',') { index++; continue; }
    if (text[index] === '}') return { value: result, end: index + 1 };
    return { value: result, end: undefined };
  }
  return { value: result, end: undefined };
}

async function readCodexLifecycle(file, cursor, startedAt = 0) {
  const stat = await fs.stat(file);
  const reset = !cursor || cursor.file !== file || stat.ino !== cursor.ino || stat.size < cursor.offset;
  if (reset) {
    const baseline = await readCodexBaseline(file, stat.size, startedAt);
    return { cursor: { file, ino: stat.ino, offset: baseline.offset, working: baseline.working, turnId: baseline.turnId, activityAt: baseline.activityAt }, reset, completions: baseline.completions };
  }
  const start = cursor.offset;
  const length = Math.min(stat.size - start, 262144);
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let completeLength = buffer.subarray(0, bytesRead).lastIndexOf(0x0a) + 1;
    if (!completeLength && bytesRead === 262144) completeLength = bytesRead;
    let working = cursor.working;
    let turnId = cursor.turnId;
    let activityAt = cursor.activityAt;
    const completions = [];
    forEachLinePrefix(buffer, completeLength, line => {
      const event = codexEventMetadata(line);
      if (event?.type === 'task_started' && event.turn_id) { working = true; turnId = event.turn_id; activityAt = eventActivityAt(event) || activityAt; }
      else if (event?.type === 'task_complete' && event.turn_id && (!turnId || event.turn_id === turnId)) {
        working = false;
        const completedAt = typeof event.completed_at === 'number' ? event.completed_at * 1000 : Date.parse(event.timestamp || '') || Date.now();
        activityAt = Number.isFinite(completedAt) ? completedAt : activityAt;
        completions.push({ turnId:event.turn_id, completedAt });
        turnId = undefined;
      } else if (event?.type === 'turn_aborted' && (!event.turn_id || !turnId || event.turn_id === turnId)) { working = false; activityAt = eventActivityAt(event) || activityAt; turnId = undefined; }
    });
    return { cursor: { file, ino: stat.ino, offset: start + completeLength, working, turnId, activityAt }, reset, completions };
  } finally { await handle.close(); }
}

function codexEventMetadata(prefix) {
  const row = readCodexMetadataObject(prefix, prefix.search(/\S/), new Set(['timestamp','type']), ['type','turn_id','completed_at'])?.value;
  return row?.type === 'event_msg' ? { ...row.payload, timestamp: row.timestamp } : undefined;
}

function eventActivityAt(event) {
  if (typeof event?.completed_at === 'number') return event.completed_at * 1000;
  const parsed = Date.parse(event?.timestamp || '');
  return Number.isFinite(parsed) ? parsed : undefined;
}

function forEachLinePrefix(buffer, length, callback) {
  const maxPrefix = 2048;
  let start = 0;
  while (start < length) {
    const newline = buffer.indexOf(0x0a, start);
    const end = newline < 0 || newline >= length ? length : newline;
    const prefixEnd = Math.min(end, start + maxPrefix);
    callback(buffer.subarray(start, prefixEnd).toString('utf8'));
    if (newline < 0 || newline >= length) break;
    start = newline + 1;
  }
}

async function readCodexBaseline(file, size, startedAt) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    const prefix = Buffer.alloc(2048);
    let position = 0, lineOffset = 0, prefixLength = 0;
    let working = false, turnId, activityAt;
    const completions = [];
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) break;
      let index = 0;
      while (index < bytesRead) {
        const newline = buffer.indexOf(0x0a, index);
        const end = newline < 0 || newline >= bytesRead ? bytesRead : newline;
        const take = Math.min(end - index, prefix.length - prefixLength);
        if (take > 0) { buffer.copy(prefix, prefixLength, index, index + take); prefixLength += take; }
        if (newline < 0 || newline >= bytesRead) break;
        const event = codexEventMetadata(prefix.subarray(0, prefixLength).toString('utf8'));
        if (event?.type === 'task_started' && event.turn_id) { working = true; turnId = event.turn_id; activityAt = eventActivityAt(event) || activityAt; }
        else if (event?.type === 'task_complete' && event.turn_id && (!turnId || event.turn_id === turnId)) {
          working = false;
          const completedAt = typeof event.completed_at === 'number' ? event.completed_at * 1000 : Date.parse(event.timestamp || '');
          if (Number.isFinite(completedAt)) activityAt = completedAt;
          if (Number.isFinite(completedAt) && completedAt >= startedAt) completions.push({ turnId:event.turn_id, completedAt });
          turnId = undefined;
        } else if (event?.type === 'turn_aborted' && (!event.turn_id || !turnId || event.turn_id === turnId)) { working = false; activityAt = eventActivityAt(event) || activityAt; turnId = undefined; }
        lineOffset = position + newline + 1;
        prefixLength = 0;
        index = newline + 1;
      }
      position += bytesRead;
    }
    return { working, turnId, offset: lineOffset, completions, activityAt };
  } finally { await handle.close(); }
}

async function readCodexThreadHeader(file) {
  let handle;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return undefined;
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const start = text.search(/\S/);
    if (start < 0 || text[start] !== '{') return undefined;
    // Codex headers can carry very large instruction payloads on the first line,
    // so parse incrementally instead of JSON.parse-ing the whole line.
    const row = readCodexMetadataObject(text, start, new Set(['type']), ['id', 'cwd', 'parent_thread_id', 'thread_source'])?.value;
    const meta = row?.type === 'session_meta' ? row.payload : undefined;
    if (!meta?.id || !path.isAbsolute(meta.cwd || '')) return undefined;
    return { id: meta.id, cwd: meta.cwd, ...(meta.parent_thread_id ? { parentThreadId: meta.parent_thread_id } : {}), ...(meta.thread_source === 'subagent' ? { subagent: true } : {}) };
  } catch { return undefined; }
  finally { await handle?.close().catch(() => {}); }
}

async function readCodexLockSession(sessionId, files) {
  const rollout = files.find(item => item.file.endsWith(`-${sessionId}.jsonl`));
  if (!rollout) return undefined;
  const meta = await readCodexThreadHeader(rollout.file);
  if (!meta || meta.id !== sessionId) return undefined;
  return { provider: 'codex', sessionId, sessionFile: rollout.file, cwd: meta.cwd, ...(meta.parentThreadId ? { parentThreadId: meta.parentThreadId } : {}), ...(meta.subagent ? { subagent: true } : {}) };
}

// Codex 0.167+ delegates thread writing to a shared app-server daemon that is
// detached from every terminal (ppid 1) and holds the thread-writer locks of ALL
// live conversations, including subagent threads. Per-terminal lock inspection
// therefore sees nothing. Recover the exact binding from the daemon-held locks:
// keep only main threads (no parent_thread_id) whose rollout working folder is
// exactly this terminal's Codex working folder, minus conversations already
// bound to other live entries. Bind only when exactly one candidate remains.
async function resolveSharedCodexSession(files, cwd, exclude) {
  if (!cwd || !path.isAbsolute(cwd)) return undefined;
  const lockIds = [...new Set(files.filter(item => /thread-writer-locks\/[0-9a-f-]+\.lock$/.test(item.file)).map(item => path.basename(item.file, '.lock')))];
  let match;
  for (const sessionId of lockIds) {
    if (exclude?.has(sessionId)) continue;
    const session = await readCodexLockSession(sessionId, files);
    if (!session || session.parentThreadId || session.subagent) continue; // Subagent threads never own a terminal.
    if (path.resolve(session.cwd) !== path.resolve(cwd)) continue;
    if (match) return undefined; // Two live conversations share this folder: never guess.
    match = { provider: 'codex', sessionId, sessionFile: session.sessionFile, cwd: session.cwd };
  }
  return match;
}

async function readManagedCodexSession(entry, managedId, codexPresent) {
  if (!codexPresent || !entry || managedId !== entry.id || entry.provider !== 'codex' || !entry.sessionId || !path.isAbsolute(entry.sessionFile || '')) return undefined;
  const meta = await readCodexThreadHeader(entry.sessionFile);
  if (meta?.id !== entry.sessionId || (entry.cwd && path.resolve(meta.cwd) !== path.resolve(entry.cwd))) return undefined;
  return { provider: 'codex', sessionId: entry.sessionId, sessionFile: entry.sessionFile, cwd: meta.cwd };
}

function consumeCompletion(key, completedAt, seen, startedAt = Infinity) {
  if (!Number.isFinite(completedAt)) return false;
  const previous = seen.get(key);
  seen.set(key, completedAt);
  return Number.isFinite(previous) ? completedAt > previous : completedAt >= startedAt;
}

async function installPiBridge(home = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), stateDirectory = registry) {
  const file = path.join(home, 'extensions/vscode-agent-session-restore.ts');
  await fs.mkdir(path.dirname(file), { recursive: true });
  let code = `// Installed by the local VS Code Agent Session Restore extension.
import fs from 'node:fs';
import path from 'node:path';
export default function(pi: any) {
  if (process.env.TERM_PROGRAM !== 'vscode') return;
  const folder = __STATE_DIRECTORY__;
  let activeSessionId;
  let working = false;
  const publish = (isWorking: boolean, completed: boolean, ctx: any) => {
    const target = path.join(folder, String(process.pid)+'.json');
    const clearStale = () => {
      try {
        const old = JSON.parse(fs.readFileSync(target,'utf8'));
        if (old?.provider === 'pi') fs.unlinkSync(target);
      } catch {}
    };
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      const sessionId = ctx.sessionManager.getSessionId();
      const cwd = ctx.cwd;
      if (!sessionFile || !sessionId || !path.isAbsolute(cwd || '')) { clearStale(); return; }
      // Pi assigns a prospective path at session_start, but creates JSONL only after
      // the first user/assistant message. Verify its metadata header before publishing.
      const fd = fs.openSync(sessionFile, 'r');
      let header;
      try {
        const buffer = Buffer.alloc(65536);
        const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const newline = buffer.subarray(0, count).indexOf(10);
        if (newline < 0) { clearStale(); return; }
        header = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
      } finally { fs.closeSync(fd); }
      if (header?.type !== 'session' || header.id !== sessionId || !path.isAbsolute(header.cwd || '') || path.resolve(header.cwd) !== path.resolve(cwd)) { clearStale(); return; }
      fs.mkdirSync(folder, {recursive:true});
      const temp = target+'.tmp';
      let previous;
      try { previous = JSON.parse(fs.readFileSync(target,'utf8')); } catch {}
      const same = previous?.provider === 'pi' && previous?.sessionId === sessionId;
      const completedAt = completed && same && previous.working === true ? Date.now() : same ? previous.completedAt : undefined;
      const activityAt = (isWorking || completed && same && previous.working === true) ? Date.now() : same ? previous.activityAt : undefined;
      fs.writeFileSync(temp, JSON.stringify({pid:process.pid,provider:'pi',sessionId,sessionFile,cwd,working:isWorking,...(completedAt ? {completedAt} : {}),...(activityAt ? {activityAt} : {}),updatedAt:Date.now()}));
      fs.renameSync(temp,target);
    } catch { clearStale(); }
  };
  pi.on('session_start', (_event: any, ctx: any) => {
    activeSessionId = ctx.sessionManager.getSessionId();
    working = false;
    publish(false, false, ctx);
  });
  pi.on('agent_start', (_event: any, ctx: any) => {
    activeSessionId = ctx.sessionManager.getSessionId();
    working = true;
    publish(true, false, ctx);
  });
  // message_end handlers run before Pi appends the message. Defer one event-loop turn
  // so the durable header/message append completes, without retaining prompt contents.
  pi.on('message_end', (_event: any, ctx: any) => {
    if (!working) return;
    const sessionId = ctx.sessionManager.getSessionId();
    setTimeout(() => {
      if (working && activeSessionId === sessionId && ctx.sessionManager.getSessionId() === sessionId) publish(true, false, ctx);
    }, 0);
  });
  pi.on('agent_settled', (_event: any, ctx: any) => {
    working = false;
    activeSessionId = ctx.sessionManager.getSessionId();
    publish(false, true, ctx);
  });
}
`;
  code = code.replace('__STATE_DIRECTORY__', JSON.stringify(stateDirectory));
  const previous = await fs.readFile(file, 'utf8').catch(() => '');
  if (previous !== code) await fs.writeFile(file, code);
}

class AutomaticTracker {
  constructor(vscode, manager, log, options = {}) {
    this.vscode = vscode;
    this.manager = manager;
    this.log = log;
    this.platform = options.platform || process.platform;
    this.testMode = options.testMode === true;
    this.installPi = options.installPiBridge || installPiBridge;
    this.installAgents = options.installAgentBridges || installAgentBridges;
    this.writeProgress = options.writeTerminalProgress || writeTerminalProgress;
    this.completionStatusBar = options.completionStatusBar;
    this.execFile = options.execFile || execFile;
    this.registry = options.registry || registry;
    this.readLifecycle = options.readCodexLifecycle || readCodexLifecycle;
    this.preparePromise = undefined;
    this.busy = false;
    this.startedAt = Date.now();
    this.terminalIds = new WeakMap();
    this.missing = new Map();
    this.codexLifecycle = new Map();
    this.codexLocksByTerminal = new WeakMap();
    this.notifiedCodexTurns = new Set();
    this.notifiedCompletionKeys = new Set();
    this.completionsSeen = new Map();
    this.terminalProgress = new Map();
  }

  async sample() {
    if (this.busy || !this.vscode.workspace.isTrusted || process.platform === 'win32') return;
    this.busy = true;
    try {
      const terminals = [...this.vscode.window.terminals];
      const shells = await Promise.all(terminals.map(async terminal => ({ terminal, pid: await terminal.processId })));
      const { stdout } = await this.execFile('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 5000 });
      const processes = parseProcesses(stdout);
      const alive = new Set(processes.map(p => p.pid));
      const reports = new Map();
      for (const name of await fs.readdir(this.registry).catch(() => [])) {
        if (!/^\d+\.json$/.test(name)) continue;
        try {
          const report = JSON.parse(await fs.readFile(path.join(this.registry, name), 'utf8'));
          if (alive.has(report.pid) && ['pi', 'claude', 'agy'].includes(report.provider) && path.isAbsolute(report.cwd || '')) reports.set(report.pid, report);
        } catch {}
      }
      const agentPids = processes.filter(p => /(?:^|\/)codex$/.test(p.command)).map(p => p.pid);
      let files = [];
      const codexCwds = new Map();
      if (agentPids.length) {
        try {
          const output = await this.execFile('/usr/sbin/lsof', ['-nP', '-p', agentPids.join(','), '-Fn'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
          files = parseOpenFiles(output.stdout);
        } catch (error) { if (error.stdout) files = parseOpenFiles(error.stdout); }
        try {
          const output = await this.execFile('/usr/sbin/lsof', ['-nP', '-a', '-p', agentPids.join(','), '-d', 'cwd', '-Fn'], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
          const byPid = new Map();
          for (const row of parseOpenFiles(output.stdout)) {
            if (!path.isAbsolute(row.file)) continue;
            if (!byPid.has(row.pid)) byPid.set(row.pid, new Set());
            byPid.get(row.pid).add(row.file);
          }
          for (const [cwdPid, paths] of byPid) if (paths.size === 1) codexCwds.set(cwdPid, [...paths][0]);
        } catch (error) { if (error.stdout) this.log(`Codex working-folder lookup incomplete: ${error.message}`); }
      }
      let dirty = false;
      const workingNow = new Set();
      const activeCodexKeys = new Set();
      const visibleStates = new Map();
      let liveOnlyChanged = false;
      for (const { terminal, pid } of shells) {
        if (!pid || !this.vscode.window.terminals.includes(terminal)) continue;
        const owner = terminalAgent(pid, processes);
        const children = owner.children;
        const managedId = terminal.creationOptions.env?.AGENT_SESSION_RESTORE_ID;
        const id = this.terminalIds.get(terminal) || managedId || [...this.manager.live].find(([, live]) => live === terminal)?.[0];
        let entry = id && this.manager.entries.find(row => row.id === id);
        const liveOnlyEntry = id && this.manager.liveOnlyEntries?.get(id);
        const codexPresent = processes.some(p => children.has(p.pid) && /(?:^|\/)codex$/.test(p.command));
        const pi = [...reports.values()].filter(report => children.has(report.pid) && report.provider === owner.provider);
        const locks = files.filter(item => children.has(item.pid) && /thread-writer-locks\/[0-9a-f-]+\.lock$/.test(item.file));
        const ids = [...new Set(locks.map(item => path.basename(item.file, '.lock')))];
        const previousLocks = this.codexLocksByTerminal.get(terminal);
        let session;
        if (pi.length === 1) session = pi[0];
        else if (owner.provider === 'codex' && ids.length) {
          const candidates = (await Promise.all(ids.map(lockId => readCodexLockSession(lockId, files))))
            .filter(candidate => candidate && !candidate.parentThreadId && !candidate.subagent);
          this.codexLocksByTerminal.set(terminal, new Set(candidates.map(candidate => candidate.sessionId)));
          if (candidates.length === 1) session = candidates[0];
          else if (previousLocks) {
            // A dedicated server can retain the old conversation's writer lock
            // after /new. Follow a single new main-thread lock in THIS terminal's
            // process tree, never a globally recent thread or another terminal.
            const added = candidates.filter(candidate => !previousLocks.has(candidate.sessionId));
            if (added.length === 1) session = added[0];
          }
        }
        const boundToEntry = Boolean(entry && (managedId === entry.id || this.terminalIds.get(terminal) === entry.id || this.manager.live.get(entry.id) === terminal));
        if (!session && entry?.provider === 'codex' && boundToEntry && codexPresent) {
          session = await readManagedCodexSession(entry, entry.id, codexPresent);
        }
        if (!session && owner.provider === 'codex' && codexPresent) {
          const rootCwd = owner.rootPids?.map(rootPid => codexCwds.get(rootPid)).find(Boolean);
          if (rootCwd) {
            const claimed = new Set(this.manager.entries.filter(row => row.provider === 'codex' && row.sessionId && row.id !== entry?.id && this.manager.live.has(row.id)).map(row => row.sessionId));
            session = await resolveSharedCodexSession(files, rootCwd, claimed);
          }
        }
        if (!session && entry?.provider === 'codex' && boundToEntry && !codexPresent) {
          await this.updateTerminalProgress(terminal, false, pid);
        }
        let liveOnlyRemoved = false;
        if (session) {
          if (session.provider === 'codex' && session.sessionFile) {
            const lifecycleKey = `codex:${session.sessionId}`;
            activeCodexKeys.add(lifecycleKey);
            const lifecycle = await this.readLifecycle(session.sessionFile, this.codexLifecycle.get(lifecycleKey), this.startedAt);
            this.codexLifecycle.set(lifecycleKey, lifecycle.cursor);
            session.working = lifecycle.cursor.working;
            session.lifecycleReset = lifecycle.reset;
            session.completedTurns = lifecycle.completions;
            session.activityAt = lifecycle.cursor.activityAt || session.activityAt;
          }
          liveOnlyRemoved = this.manager.removeLiveOnlyForTerminal?.(terminal, false) === true;
          const observed = this.manager.observe(session, terminal, id);
          entry = observed.entry;
          dirty ||= observed.dirty;
          const previousWorking = this.manager.working.has(entry.id);
          if (session.working === true) workingNow.add(entry.id);
          const state = session.working === true ? 'working' : session.working === false ? 'open' : 'unknown';
          const oldStatus = this.manager.status?.get(entry.id);
          const reason = state === 'unknown' ? 'The agent process is open, but its task state cannot be identified from supported lifecycle events.' : undefined;
          if (state === 'unknown' && oldStatus?.state !== 'unknown') this.log(`Task status unknown for ${entry.provider} session ${entry.name}: ${reason}`);
          this.manager.status?.set(entry.id, { state, ...(reason ? { reason } : {}), updatedAt: Date.now() });
          visibleStates.set(entry.id, `${state}:${reason || ''}`);
          if (typeof session.working === 'boolean' && previousWorking !== session.working && !session.activityAt) {
            const activityAt = Date.now();
            entry.lastActivityAt = Math.max(entry.lastActivityAt || 0, activityAt);
            dirty = true;
          }
          if (typeof session.working === 'boolean') await this.updateTerminalProgress(terminal, session.working, pid);
          else await this.updateTerminalProgress(terminal, false, pid);
          const notifications = this.vscode.workspace.getConfiguration('agentSessionRestore').get('completionNotifications', true);
          const gotCompletion = consumeCompletion(entry.id, session.completedAt, this.completionsSeen, this.startedAt);
          if (session.provider !== 'codex' && gotCompletion) {
            entry.lastActivityAt = Math.max(entry.lastActivityAt || 0, normalizeActivity(session.completedAt) || Date.now());
            dirty = true;
            if (notifications) this.notifyCompletion(entry, `${session.provider}:${entry.id}:${session.completedAt}`);
          }
          if (session.provider === 'codex') for (const completion of session.completedTurns || []) {
            const notificationKey = `codex:${session.sessionId}:${completion.turnId}`;
            if (this.notifiedCodexTurns.has(notificationKey)) continue;
            this.notifiedCodexTurns.add(notificationKey);
            this.boundSet(this.notifiedCodexTurns, 2048);
            entry.lastActivityAt = Math.max(entry.lastActivityAt || 0, normalizeActivity(completion.completedAt) || Date.now());
            dirty = true;
            const recentEnough = completion.completedAt >= this.startedAt;
            if (notifications && recentEnough) this.notifyCompletion(entry, notificationKey);
          }
          this.terminalIds.set(terminal, entry.id);
          this.missing.delete(entry.id);
        } else if (entry?.automatic) {
          // Leave mappings intact when an agent is still present but its exact session
          // cannot be read (e.g. a shared Codex daemon). Never guess from recency.
          const agentPresent = owner.present;
          await this.updateTerminalProgress(terminal, false, pid);
          const state = agentPresent ? 'unknown' : 'saved';
          const waitingForLifecycle = agentPresent && boundToEntry && owner.provider === entry.provider && ['agy', 'claude', 'pi'].includes(entry.provider);
          const reason = waitingForLifecycle
            ? 'The restored agent process is attached. Waiting for its first lifecycle report; task activity is not known yet. Resumed sessions may report only after the next request.'
            : agentPresent
            ? 'An agent is still running, but the exact conversation or task lifecycle is not identifiable. Check Logs or reopen the saved session.'
            : 'No agent process is attached to this terminal. The saved conversation can be opened again.';
          this.manager.status?.set(entry.id, { state, reason, updatedAt: Date.now() });
          if (agentPresent && this.lastVisibleStates?.get(entry.id) !== `${state}:${reason}`) this.log(`${waitingForLifecycle ? 'Waiting for lifecycle report' : 'Session status unknown'} for ${entry.provider} session ${entry.name}: ${reason}`);
          visibleStates.set(entry.id, `${state}:${reason}`);
          if (ids.length > 1 && !entry.unresolved) { entry.unresolved = true; dirty = true; }
          if (!agentPresent) {
            const since = this.missing.get(entry.id) || Date.now();
            this.missing.set(entry.id, since);
            if (Date.now() - since > 10000) {
              if (entry.enabled !== false || !entry.archived) { entry.enabled = false; entry.archived = true; dirty = true; }
              this.manager.live.delete(entry.id);
            }
          }
        } else if (liveOnlyEntry || (!entry && owner.provider === 'codex' && codexPresent)) {
          if (!owner.present || (owner.provider && owner.provider !== 'codex')) {
            if (liveOnlyEntry) this.manager.removeLiveOnly(liveOnlyEntry.id);
          } else if (!entry && owner.provider === 'codex' && owner.rootPids?.length === 1) {
            const cwd = codexCwds.get(owner.rootPids[0]);
            if (cwd) this.manager.upsertLiveOnly(terminal, 'codex', cwd);
          }
        }
        liveOnlyChanged ||= liveOnlyRemoved;
      }
      const liveCodexKeys = new Set(this.manager.entries.filter(entry => entry.provider === 'codex' && terminals.some(terminal => this.manager.live.get(entry.id) === terminal)).map(entry => `codex:${entry.sessionId}`));
      for (const key of this.codexLifecycle.keys()) if (!activeCodexKeys.has(key) && !liveCodexKeys.has(key)) this.codexLifecycle.delete(key);
      this.manager.working = workingNow;
      const statusChanges = [];
      for (const [id, value] of visibleStates) {
        const previous = this.lastVisibleStates?.get(id);
        if (previous !== value) statusChanges.push(id);
      }
      for (const [id] of (this.manager.status || [])) if (!visibleStates.has(id) && this.lastVisibleStates?.has(id)) statusChanges.push(id);
      this.lastVisibleStates = visibleStates;
      if (dirty) await this.manager.save();
      else if (statusChanges.length) for (const id of statusChanges) this.manager.changed(id);
      else if (liveOnlyChanged) this.manager.changed();
    } catch (error) { this.log(`Observer: ${error.message}`); }
    finally { this.busy = false; }
  }

  boundSet(set, limit) {
    while (set.size > limit) set.delete(set.values().next().value);
  }

  notifyCompletion(entry, dedupeKey = `${entry.provider}:${entry.id}:${entry.sessionId}`) {
    if (this.notifiedCompletionKeys.has(dedupeKey)) return;
    this.notifiedCompletionKeys.add(dedupeKey);
    this.boundSet(this.notifiedCompletionKeys, 2048);
    const targets = notificationTargets(this.vscode);
    if (targets.statusBar) this.completionStatusBar?.add(entry, dedupeKey);
    if (!targets.native) return;
    const pathName = path.basename(entry.cwd || '') || entry.cwd || 'unknown folder';
    const providerName = ({ codex:'Codex', pi:'pi', claude:'Claude', agy:'Antigravity' })[entry.provider] || entry.provider;
    // Native notification buttons close the toast and can restore focus to the
    // previously active editor. A command link leaves the toast open, so revealing
    // the terminal never competes with that editor-focus restoration.
    const command = `command:agentSessionRestore.openCompletedSession?${encodeURIComponent(JSON.stringify([entry.id, entry.provider, entry.sessionId]))}`;
    const summary = completionSummary(entry.name);
    // Keep the clickable label at the start of a short, single-line toast. Native
    // notification controls consume width on hover; long text can expand the toast
    // and move a trailing link away from the pointer.
    const tooltip = `${providerName} · ${entry.name} · ${entry.cwd || pathName}`.replace(/[\\"\r\n]/g, ' ');
    void this.vscode.window.showInformationMessage(`[Open Session](${command} "${tooltip}") · ${providerName} · ${summary} ✓`)
      .then(undefined, error => this.log(`Notification failed: ${error.message}`));
  }

  async updateTerminalProgress(terminal, working, pid) {
    const known = this.terminalProgress.has(terminal);
    const wasWorking = this.terminalProgress.get(terminal);
    if (!known) {
      const processId = await Promise.resolve(terminal.processId).catch(() => undefined);
      if (processId !== pid) return;
      if (await this.writeProgress(terminal, working, { platform: this.platform, terminals: this.vscode.window.terminals })) {
        this.terminalProgress.set(terminal, working);
      }
      return;
    }
    // The CLI can reset OSC progress while repainting its own status. Reassert
    // an active task on each sample; idle remains a one-time transition.
    if (wasWorking === working && !working) return;
    if (!working) {
      if (await this.writeProgress(terminal, false, { platform: this.platform, terminals: this.vscode.window.terminals })) this.terminalProgress.set(terminal, false);
      return;
    }
    const processId = await Promise.resolve(terminal.processId).catch(() => undefined);
    if (processId !== pid) return;
    if (await this.writeProgress(terminal, true, { platform: this.platform, terminals: this.vscode.window.terminals })) this.terminalProgress.set(terminal, true);
  }

  async start() {
    if (this.platform === 'win32') { this.log('Automatic process tracking is currently supported on macOS.'); return; }
    try { await this.prepare(); } catch (error) { this.log(`Observer setup failed: ${error.message}`); }
    await this.sample();
    this.timer = setInterval(() => void this.sample(), 2000);
  }

  async prepare() {
    if (this.platform === 'win32' || this.testMode) return;
    if (!this.preparePromise) {
      this.preparePromise = (async () => {
        await this.installPi();
        await this.installAgents();
      })().catch(error => { this.preparePromise = undefined; throw error; });
    }
    return this.preparePromise;
  }

  async restoreAfterPrepare(restore) {
    try { await this.prepare(); }
    catch (error) { this.log(`Observer setup failed; continuing session restore: ${error.message}`); }
    return restore();
  }

  closed(terminal) {
    this.terminalProgress.delete(terminal);
    const id = this.terminalIds.get(terminal);
    const entry = this.manager.entries.find(row => row.id === id);
    // Keep per-session completion cursors and bounded notified-turn history across
    // terminal restarts so a historical task cannot announce itself again.
    this.terminalIds.delete(terminal);
  }

  dispose() {
    clearInterval(this.timer);
    for (const [terminal, working] of this.terminalProgress) if (working) void this.writeProgress(terminal, false, { platform: this.platform, terminals: this.vscode.window.terminals });
    this.terminalProgress.clear();
  }
}
module.exports = { completionSummary, AutomaticTracker, descendants, terminalAgent, parseProcesses, parseOpenFiles, readCodexLifecycle, readCodexThreadHeader, readCodexLockSession, resolveSharedCodexSession, readManagedCodexSession, consumeCompletion, installPiBridge, normalizeActivity };
