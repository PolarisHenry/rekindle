'use strict';

const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { sessionKey, launchOptions, resumeCommand, newSessionCommand, startupArguments } = require('./core');
const { createAgentTerminal, ShellGate } = require('./python-terminal');
const { retireIdleTerminal } = require('./startup');
const { agentIcon } = require('./agent-icons');
const STORAGE_KEY = 'agentSessionRestore.sessions.v1';

class SessionManager {
  constructor(vscode, context, log, changed) {
    this.vscode = vscode;
    this.context = context;
    this.log = log;
    this.changed = changed;
    this.entries = this.readEntries();
    this.pending = new Map();
    this.live = new Map();
    this.working = new Set();
    this.opening = new Map();
    this.writes = Promise.resolve();
    this.shellGate = new ShellGate(vscode);
    context.subscriptions?.push(this.shellGate);
  }

  readEntries() {
    return this.context.workspaceState.get(STORAGE_KEY, []).filter(entry => {
      try { launchOptions(entry); return typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.cwd === 'string'; }
      catch { return false; }
    }).map(entry => ({ ...entry, enabled: entry.enabled !== false }));
  }

  config() {
    const c = this.vscode.workspace.getConfiguration('agentSessionRestore');
    return Object.fromEntries(['autoRestore', 'codexCommand', 'piCommand', 'claudeCommand', 'agyCommand', 'codexArguments', 'piArguments', 'claudeArguments', 'agyArguments', 'codexHome', 'piHome', 'claudeHome', 'agyHome'].map(key => [key, c.get(key)]));
  }

  async save() {
    const snapshot = this.entries.map(entry => ({ ...entry }));
    this.writes = this.writes.catch(() => {}).then(() => this.context.workspaceState.update(STORAGE_KEY, snapshot));
    await this.writes;
    this.changed();
  }

  async add(session, name, enabled = true) {
    const existing = this.entries.find(entry => sessionKey(entry) === sessionKey(session));
    if (existing) {
      // Adding a conversation that is already tracked is an explicit rename/update,
      // never a silent no-op. Preserve its restore setting and stable identity.
      if (name && (existing.name !== name || !existing.customName)) { existing.name = name; existing.customName = true; await this.save(); }
      return existing;
    }
    const entry = { id: randomUUID(), provider: session.provider, sessionId: session.sessionId,
      sessionFile: session.sessionFile, cwd: session.cwd, name, customName: true, enabled, createdAt: new Date().toISOString() };
    this.entries.push(entry);
    await this.save();
    return entry;
  }

  async setEnabled(id, enabled) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) return;
    entry.enabled = enabled;
    entry.archived = false;
    await this.save();
  }

  observe(session, terminal, previousId) {
    let entry = this.entries.find(row => row.id === previousId);
    let dirty = false;
    if (entry && sessionKey(entry) !== sessionKey(session)) {
      entry.enabled = false;
      entry.archived = true;
      this.live.delete(entry.id);
      entry = undefined;
      dirty = true;
    }
    if (!entry) entry = this.entries.find(row => sessionKey(row) === sessionKey(session));
    if (!entry) {
      const pending = this.pending.get(previousId);
      entry = {
        id: pending ? previousId : randomUUID(),
        ...(pending ? { name: pending.name, customName: pending.customName === true } : {}),
        provider: session.provider, sessionId: session.sessionId, sessionFile: session.sessionFile,
        cwd: session.cwd, enabled: pending?.enabled ?? true,
        createdAt: pending?.createdAt || new Date().toISOString()
      };
      this.entries.push(entry);
      dirty = true;
    }
    this.pending.delete(previousId);
    const values = { provider: session.provider, sessionId: session.sessionId, sessionFile: session.sessionFile, cwd: session.cwd, name: entry.customName ? entry.name : terminal.name, automatic: true, unresolved: false };
    if (Object.keys(values).some(key => entry[key] !== values[key])) { Object.assign(entry, values); dirty = true; }
    this.live.set(entry.id, terminal);
    return { entry, dirty };
  }

  async create(session, name) {
    if (!this.vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting agents.');
    const entry = { ...session, id: randomUUID(), name, customName: true };
    const config = this.config();
    const command = newSessionCommand(entry.provider, config);
    const stat = await fs.stat(entry.cwd).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Project directory not found: ${entry.cwd}`);
    const options = launchOptions({ ...entry, sessionId: 'pending' }, config);
    if (process.platform === 'win32') options.shellArgs = startupArguments(entry.provider, config);
    this.pending.set(entry.id, entry);
    let terminal;
    try {
      terminal = await createAgentTerminal(this.vscode, { ...options, iconPath: agentIcon(this.vscode, entry.provider) }, this.log);
      entry.terminal = terminal;
      await this.startInShell(terminal, entry, command);
      terminal.show(false);
      return terminal;
    } catch (error) {
      this.pending.delete(entry.id);
      terminal?.dispose();
      throw error;
    }
  }

  async startInShell(terminal, entry, startupCommand) {
    if (process.platform === 'win32') return; // Windows still starts the CLI directly.
    if (!terminal.shellIntegration && this.vscode.window.onDidChangeTerminalShellIntegration) {
      await new Promise(resolve => {
        let subscription;
        const done = () => { clearTimeout(timer); subscription?.dispose(); resolve(); };
        const timer = setTimeout(done, 4000);
        subscription = this.vscode.window.onDidChangeTerminalShellIntegration(event => {
          if (event.terminal === terminal && terminal.shellIntegration) done();
        });
        if (terminal.shellIntegration) done();
      });
    }
    if (!this.vscode.window.terminals.includes(terminal) || (!this.entries.some(item => item.id === entry.id) && !this.pending.has(entry.id))) return;
    const pythonInstalled = this.vscode.extensions?.getExtension('ms-python.python') || this.vscode.extensions?.getExtension('ms-python.vscode-python-envs');
    await this.shellGate.wait(terminal, { grace: pythonInstalled ? 1000 : 0 });
    if (!this.vscode.window.terminals.includes(terminal)) return;
    const command = startupCommand || resumeCommand(entry, this.config());
    if (terminal.shellIntegration) terminal.shellIntegration.executeCommand(command);
    else terminal.sendText(command, true);
  }

  async open(entry, reveal = true) {
    if (entry.unresolved) throw new Error('Cannot identify this terminal in a shared Codex daemon. Restore skipped to avoid opening the wrong conversation.');
    if (!this.vscode.workspace.isTrusted) throw new Error('Trust this workspace before restoring agent sessions.');
    if (!this.entries.some(item => item.id === entry.id)) throw new Error('This session is no longer tracked.');
    const known = this.live.get(entry.id) || this.vscode.window.terminals.find(terminal => terminal.creationOptions.env?.AGENT_SESSION_RESTORE_ID === entry.id);
    if (known && known.exitStatus === undefined && this.vscode.window.terminals.includes(known)) {
      this.live.set(entry.id, known);
      if (reveal) known.show(true);
      return known;
    }
    if (this.opening.has(entry.id)) return this.opening.get(entry.id);
    const opening = (async () => {
      const stat = await fs.stat(entry.cwd).catch(() => null);
      if (!stat?.isDirectory()) throw new Error(`Project directory not found: ${entry.cwd}`);
      if (entry.provider === 'pi' && entry.sessionFile) {
        const sessionFile = await fs.stat(entry.sessionFile).catch(() => null);
        if (!sessionFile?.isFile()) throw new Error('The saved pi session file no longer exists.');
      }
      // Check again after asynchronous filesystem validation to avoid racing an explicit remove.
      if (!this.entries.some(item => item.id === entry.id)) return;
      let revived;
      if (entry.automatic) {
        const bound = new Set(this.live.values());
        revived = this.vscode.window.terminals.find(terminal => !bound.has(terminal) && terminal.name === entry.name && terminal.exitStatus === undefined);
      }
      const terminal = await createAgentTerminal(this.vscode, { ...launchOptions(entry, this.config()), iconPath: agentIcon(this.vscode, entry.provider) }, this.log, undefined, revived);
      this.live.set(entry.id, terminal);
      await this.startInShell(terminal, entry);
      if (revived && terminal !== revived) await retireIdleTerminal(this.vscode, revived, this.log);
      if (reveal) terminal.show(true);
      this.log(`Started ${entry.provider} session ${entry.sessionId}`);
      this.changed();
      return terminal;
    })();
    this.opening.set(entry.id, opening);
    try { return await opening; }
    finally { this.opening.delete(entry.id); }
  }

  async restore() {
    const failures = [];
    let first;
    for (const entry of this.entries.filter(item => item.enabled !== false)) {
      try {
        const terminal = await this.open(entry, false);
        if (!first && terminal) first = terminal;
      }
      catch (error) { failures.push({ entry, error }); this.log(`Restore failed: ${entry.name}: ${error.message}`); }
    }
    // Set an active terminal and reveal the panel after background restoration.
    // Otherwise opening the terminal panel can create/select a default zsh tab.
    if (first && first.exitStatus === undefined && this.vscode.window.terminals.includes(first)) first.show(false);
    return failures;
  }

  async remove(id) {
    this.entries = this.entries.filter(entry => entry.id !== id);
    // Removing a saved mapping must not kill a running agent or delete its history.
    await this.save();
  }

  closed(terminal) {
    for (const [id, entry] of this.pending) if (entry.terminal === terminal) this.pending.delete(id);
    for (const [id, live] of this.live) if (live === terminal) { this.live.delete(id); this.working.delete(id); }
    // Window shutdown also emits terminal-close events. Never erase saved mappings here.
    this.changed();
  }
}

module.exports = { SessionManager, STORAGE_KEY };
