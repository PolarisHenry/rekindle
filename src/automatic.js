'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { randomUUID } = require('node:crypto');
const { installAgentBridges } = require('./bridges');

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

async function installPiBridge() {
  const home = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent');
  const file = path.join(home, 'extensions/vscode-agent-session-restore.ts');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const code = `// Installed by the local VS Code Agent Session Restore extension.\nimport fs from 'node:fs';\nimport path from 'node:path';\nexport default function(pi: any) {\n  if (process.env.TERM_PROGRAM !== 'vscode') return;\n  const folder = ${JSON.stringify(registry)};\n  const publish = (_event: any, ctx: any) => {\n    try {\n      const sessionFile = ctx.sessionManager.getSessionFile();\n      if (!sessionFile) return;\n      fs.mkdirSync(folder, {recursive:true});\n      const target = path.join(folder, String(process.pid)+'.json');\n      const temp = target+'.tmp';\n      fs.writeFileSync(temp, JSON.stringify({pid:process.pid,provider:'pi',sessionId:ctx.sessionManager.getSessionId(),sessionFile,cwd:ctx.cwd,updatedAt:Date.now()}));\n      fs.renameSync(temp,target);\n    } catch {}\n  };\n  pi.on('session_start', publish);\n  pi.on('turn_end', publish);\n}\n`;
  const previous = await fs.readFile(file, 'utf8').catch(() => '');
  if (previous !== code) await fs.writeFile(file, code);
}

class AutomaticTracker {
  constructor(vscode, manager, log) {
    this.vscode = vscode;
    this.manager = manager;
    this.log = log;
    this.busy = false;
    this.terminalIds = new WeakMap();
    this.missing = new Map();
  }

  async sample() {
    if (this.busy || !this.vscode.workspace.isTrusted || process.platform === 'win32') return;
    this.busy = true;
    try {
      const terminals = [...this.vscode.window.terminals];
      const shells = await Promise.all(terminals.map(async terminal => ({ terminal, pid: await terminal.processId })));
      const { stdout } = await execFile('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 5000 });
      const processes = parseProcesses(stdout);
      const alive = new Set(processes.map(p => p.pid));
      const reports = new Map();
      for (const name of await fs.readdir(registry).catch(() => [])) {
        if (!/^\d+\.json$/.test(name)) continue;
        try {
          const report = JSON.parse(await fs.readFile(path.join(registry, name), 'utf8'));
          if (alive.has(report.pid) && ['pi', 'claude', 'agy'].includes(report.provider) && path.isAbsolute(report.cwd || '')) reports.set(report.pid, report);
        } catch {}
      }
      const agentPids = processes.filter(p => /(?:^|\/)codex$/.test(p.command)).map(p => p.pid);
      let files = [];
      if (agentPids.length) {
        try {
          const output = await execFile('/usr/sbin/lsof', ['-nP', '-p', agentPids.join(','), '-Fn'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
          files = parseOpenFiles(output.stdout);
        } catch (error) { if (error.stdout) files = parseOpenFiles(error.stdout); }
      }
      let dirty = false;
      for (const { terminal, pid } of shells) {
        if (!pid || !this.vscode.window.terminals.includes(terminal)) continue;
        const children = descendants(pid, processes);
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
        const managedId = terminal.creationOptions.env?.AGENT_SESSION_RESTORE_ID;
        let id = this.terminalIds.get(terminal) || managedId || [...this.manager.live].find(([, live]) => live === terminal)?.[0];
        let entry = id && this.manager.entries.find(row => row.id === id);
        if (session) {
          // A process report is accepted only through this terminal's actual process tree.
          if (!entry) {
            entry = { id: randomUUID(), automatic: true, createdAt: new Date().toISOString() };
            this.manager.entries.push(entry);
            this.terminalIds.set(terminal, entry.id);
          }
          const values = { provider: session.provider, sessionId: session.sessionId, sessionFile: session.sessionFile, cwd: session.cwd, name: terminal.name, automatic: true, unresolved: false };
          if (Object.keys(values).some(key => entry[key] !== values[key])) { Object.assign(entry, values); dirty = true; }
          this.manager.live.set(entry.id, terminal);
          this.missing.delete(entry.id);
        } else if (entry?.automatic) {
          // Leave mappings intact when an agent is still present but its exact session
          // cannot be read (e.g. a shared Codex daemon). Never guess from recency.
          const agentPresent = processes.some(p => children.has(p.pid) && /(?:^|\/)(?:pi|codex|claude|agy)$/.test(p.command));
          if (ids.length > 1 && !entry.unresolved) { entry.unresolved = true; dirty = true; }
          if (!agentPresent) {
            const since = this.missing.get(entry.id) || Date.now();
            this.missing.set(entry.id, since);
            if (Date.now() - since > 10000) {
              this.manager.entries = this.manager.entries.filter(row => row.id !== entry.id);
              this.manager.live.delete(entry.id);
              dirty = true;
            }
          }
        }
      }
      if (dirty) await this.manager.save();
    } catch (error) { this.log(`Observer: ${error.message}`); }
    finally { this.busy = false; }
  }

  async start() {
    if (process.platform === 'win32') { this.log('Automatic process tracking is currently supported on macOS.'); return; }
    await installPiBridge();
    await installAgentBridges();
    await this.sample();
    this.timer = setInterval(() => void this.sample(), 2000);
  }

  dispose() { clearInterval(this.timer); }
}
module.exports = { AutomaticTracker, descendants, parseProcesses, parseOpenFiles, installPiBridge };
