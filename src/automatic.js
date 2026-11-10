'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { installAgentBridges } = require('./bridges');
const { writeTerminalProgress } = require('./terminal-progress');

const registry = path.join(os.homedir(), '.local/state/vscode-agent-session-restore/pi');

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
    return { cursor: { file, ino: stat.ino, offset: baseline.offset, working: baseline.working, turnId: baseline.turnId }, reset, completions: baseline.completions };
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
    const completions = [];
    forEachLinePrefix(buffer, completeLength, line => {
      const event = codexEventMetadata(line);
      if (event?.type === 'task_started' && event.turn_id) { working = true; turnId = event.turn_id; }
      else if (event?.type === 'task_complete' && event.turn_id && (!turnId || event.turn_id === turnId)) {
        working = false;
        const completedAt = typeof event.completed_at === 'number' ? event.completed_at * 1000 : Date.parse(event.timestamp || '') || Date.now();
        completions.push({ turnId:event.turn_id, completedAt });
        turnId = undefined;
      } else if (event?.type === 'turn_aborted' && (!event.turn_id || !turnId || event.turn_id === turnId)) { working = false; turnId = undefined; }
    });
    return { cursor: { file, ino: stat.ino, offset: start + completeLength, working, turnId }, reset, completions };
  } finally { await handle.close(); }
}

function codexEventMetadata(prefix) {
  const row = readCodexMetadataObject(prefix, prefix.search(/\S/), new Set(['timestamp','type']), ['type','turn_id','completed_at'])?.value;
  return row?.type === 'event_msg' ? { ...row.payload, timestamp: row.timestamp } : undefined;
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
    let working = false, turnId;
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
        if (event?.type === 'task_started' && event.turn_id) { working = true; turnId = event.turn_id; }
        else if (event?.type === 'task_complete' && event.turn_id && (!turnId || event.turn_id === turnId)) {
          working = false;
          const completedAt = typeof event.completed_at === 'number' ? event.completed_at * 1000 : Date.parse(event.timestamp || '');
          if (Number.isFinite(completedAt) && completedAt >= startedAt) completions.push({ turnId:event.turn_id, completedAt });
          turnId = undefined;
        } else if (event?.type === 'turn_aborted' && (!event.turn_id || !turnId || event.turn_id === turnId)) { working = false; turnId = undefined; }
        lineOffset = position + newline + 1;
        prefixLength = 0;
        index = newline + 1;
      }
      position += bytesRead;
    }
    return { working, turnId, offset: lineOffset, completions };
  } finally { await handle.close(); }
}

async function readManagedCodexSession(entry, managedId, codexPresent) {
  if (!codexPresent || !entry || managedId !== entry.id || entry.provider !== 'codex' || !entry.sessionId || !path.isAbsolute(entry.sessionFile || '')) return undefined;
  let handle;
  try {
    const stat = await fs.stat(entry.sessionFile);
    if (!stat.isFile()) return undefined;
    handle = await fs.open(entry.sessionFile, 'r');
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) return undefined;
    const header = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
    const meta = header?.type === 'session_meta' ? header.payload : undefined;
    if (meta?.id !== entry.sessionId || !path.isAbsolute(meta.cwd || '') || (entry.cwd && path.resolve(meta.cwd) !== path.resolve(entry.cwd))) return undefined;
    return { provider: 'codex', sessionId: entry.sessionId, sessionFile: entry.sessionFile, cwd: meta.cwd };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
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
  const code = `// Installed by the local VS Code Agent Session Restore extension.\nimport fs from 'node:fs';\nimport path from 'node:path';\nexport default function(pi: any) {\n  if (process.env.TERM_PROGRAM !== 'vscode') return;\n  const folder = ${JSON.stringify(stateDirectory)};\n  const publish = (working: boolean, completed: boolean, ctx: any) => {\n    try {\n      const sessionFile = ctx.sessionManager.getSessionFile();\n      if (!sessionFile) return;\n      fs.mkdirSync(folder, {recursive:true});\n      const target = path.join(folder, String(process.pid)+'.json');\n      const temp = target+'.tmp';\n      let previous;\n      try { previous = JSON.parse(fs.readFileSync(target,'utf8')); } catch {}\n      const sessionId = ctx.sessionManager.getSessionId();\n      const same = previous?.provider === 'pi' && previous?.sessionId === sessionId;\n      const completedAt = completed && same && previous.working === true ? Date.now() : same ? previous.completedAt : undefined;\n      fs.writeFileSync(temp, JSON.stringify({pid:process.pid,provider:'pi',sessionId,sessionFile,cwd:ctx.cwd,working,...(completedAt ? {completedAt} : {}),updatedAt:Date.now()}));\n      fs.renameSync(temp,target);\n    } catch {}\n  };\n  pi.on('session_start', (_event: any, ctx: any) => publish(false, false, ctx));\n  pi.on('agent_start', (_event: any, ctx: any) => publish(true, false, ctx));\n  pi.on('agent_settled', (_event: any, ctx: any) => publish(false, true, ctx));\n}\n`;
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
    this.execFile = options.execFile || execFile;
    this.registry = options.registry || registry;
    this.readLifecycle = options.readCodexLifecycle || readCodexLifecycle;
    this.preparePromise = undefined;
    this.busy = false;
    this.startedAt = Date.now();
    this.terminalIds = new WeakMap();
    this.missing = new Map();
    this.codexLifecycle = new Map();
    this.notifiedCodexTurns = new Set();
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
      if (agentPids.length) {
        try {
          const output = await this.execFile('/usr/sbin/lsof', ['-nP', '-p', agentPids.join(','), '-Fn'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
          files = parseOpenFiles(output.stdout);
        } catch (error) { if (error.stdout) files = parseOpenFiles(error.stdout); }
      }
      let dirty = false;
      const workingNow = new Set();
      const activeCodexKeys = new Set();
      for (const { terminal, pid } of shells) {
        if (!pid || !this.vscode.window.terminals.includes(terminal)) continue;
        const children = descendants(pid, processes);
        const managedId = terminal.creationOptions.env?.AGENT_SESSION_RESTORE_ID;
        const id = this.terminalIds.get(terminal) || managedId || [...this.manager.live].find(([, live]) => live === terminal)?.[0];
        let entry = id && this.manager.entries.find(row => row.id === id);
        const codexPresent = processes.some(p => children.has(p.pid) && /(?:^|\/)codex$/.test(p.command));
        const pi = [...reports.values()].filter(report => children.has(report.pid));
        const locks = files.filter(item => children.has(item.pid) && /thread-writer-locks\/[0-9a-f-]+\.lock$/.test(item.file));
        const ids = [...new Set(locks.map(item => path.basename(item.file, '.lock')))];
        let session;
        if (pi.length === 1) session = pi[0];
        else if (ids.length === 1) {
          const sessionId = ids[0];
          const rollout = files.find(item => item.file.endsWith(`-${sessionId}.jsonl`));
          if (rollout) {
            const handle = await fs.open(rollout.file, 'r');
            try {
              const buffer = Buffer.alloc(65536);
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
              const meta = JSON.parse(buffer.subarray(0, bytesRead).toString().split('\n')[0]).payload;
              if (meta.id === sessionId) session = { provider: 'codex', sessionId, sessionFile: rollout.file, cwd: meta.cwd };
            } finally { await handle.close(); }
          }
        }
        const boundToEntry = Boolean(entry && (managedId === entry.id || this.terminalIds.get(terminal) === entry.id || this.manager.live.get(entry.id) === terminal));
        if (!session && entry?.provider === 'codex' && boundToEntry && codexPresent) {
          session = await readManagedCodexSession(entry, entry.id, codexPresent);
        }
        if (!session && entry?.provider === 'codex' && boundToEntry && !codexPresent) {
          await this.updateTerminalProgress(terminal, false, pid);
        }
        if (session) {
          if (session.provider === 'codex' && session.sessionFile) {
            const lifecycleKey = `codex:${session.sessionId}`;
            activeCodexKeys.add(lifecycleKey);
            const lifecycle = await this.readLifecycle(session.sessionFile, this.codexLifecycle.get(lifecycleKey), this.startedAt);
            this.codexLifecycle.set(lifecycleKey, lifecycle.cursor);
            session.working = lifecycle.cursor.working;
            session.lifecycleReset = lifecycle.reset;
            session.completedTurns = lifecycle.completions;
          }
          const observed = this.manager.observe(session, terminal, id);
          entry = observed.entry;
          dirty ||= observed.dirty;
          if (session.working === true) workingNow.add(entry.id);
          if (typeof session.working === 'boolean') await this.updateTerminalProgress(terminal, session.working, pid);
          const notifications = this.vscode.workspace.getConfiguration('agentSessionRestore').get('completionNotifications', true);
          const gotCompletion = consumeCompletion(entry.id, session.completedAt, this.completionsSeen, this.startedAt);
          if (session.provider !== 'codex' && gotCompletion && notifications) {
            void this.vscode.window.showInformationMessage(`${entry.name} finished working.`);
          }
          if (session.provider === 'codex') for (const completion of session.completedTurns || []) {
            const notificationKey = `${session.sessionId}:${completion.turnId}`;
            if (this.notifiedCodexTurns.has(notificationKey)) continue;
            this.notifiedCodexTurns.add(notificationKey);
            const recentEnough = completion.completedAt >= this.startedAt;
            if (notifications && recentEnough) void this.vscode.window.showInformationMessage(`${entry.name} finished working.`);
          }
          this.terminalIds.set(terminal, entry.id);
          this.missing.delete(entry.id);
        } else if (entry?.automatic) {
          // Leave mappings intact when an agent is still present but its exact session
          // cannot be read (e.g. a shared Codex daemon). Never guess from recency.
          const agentPresent = processes.some(p => children.has(p.pid) && /(?:^|\/)(?:pi|codex|claude|agy)$/.test(p.command));
          if (!agentPresent) await this.updateTerminalProgress(terminal, false, pid);
          if (ids.length > 1 && !entry.unresolved) { entry.unresolved = true; dirty = true; }
          if (!agentPresent) {
            const since = this.missing.get(entry.id) || Date.now();
            this.missing.set(entry.id, since);
            if (Date.now() - since > 10000) {
              if (entry.enabled !== false || !entry.archived) { entry.enabled = false; entry.archived = true; dirty = true; }
              this.manager.live.delete(entry.id);
            }
          }
        }
      }
      const liveCodexKeys = new Set(this.manager.entries.filter(entry => entry.provider === 'codex' && terminals.some(terminal => this.manager.live.get(entry.id) === terminal)).map(entry => `codex:${entry.sessionId}`));
      for (const key of this.codexLifecycle.keys()) if (!activeCodexKeys.has(key) && !liveCodexKeys.has(key)) this.codexLifecycle.delete(key);
      this.manager.working = workingNow;
      this.manager.changed();
      if (dirty) await this.manager.save();
    } catch (error) { this.log(`Observer: ${error.message}`); }
    finally { this.busy = false; }
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
    if (wasWorking === working) return;
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
    if (entry) {
      this.codexLifecycle.delete(`codex:${entry.sessionId}`);
      this.completionsSeen.delete(entry.id);
      for (const key of this.notifiedCodexTurns) if (key.startsWith(`${entry.sessionId}:`)) this.notifiedCodexTurns.delete(key);
    }
    this.terminalIds.delete(terminal);
  }

  dispose() {
    clearInterval(this.timer);
    for (const [terminal, working] of this.terminalProgress) if (working) void this.writeProgress(terminal, false, { platform: this.platform, terminals: this.vscode.window.terminals });
    this.terminalProgress.clear();
  }
}
module.exports = { AutomaticTracker, descendants, parseProcesses, parseOpenFiles, readCodexLifecycle, readManagedCodexSession, consumeCompletion, installPiBridge };
