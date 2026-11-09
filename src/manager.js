'use strict';

const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { sessionKey, launchOptions, resumeCommand } = require('./core');
const STORAGE_KEY = 'agentSessionRestore.sessions.v1';

class SessionManager {
  constructor(vscode, context, log, changed) {
    this.vscode = vscode;
    this.context = context;
    this.log = log;
    this.changed = changed;
    this.entries = context.workspaceState.get(STORAGE_KEY, []).filter(entry => {
      try { launchOptions(entry); return typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.cwd === 'string'; }
      catch { return false; }
    });
    this.live = new Map();
    this.opening = new Map();
    this.writes = Promise.resolve();
  }

  config() {
    const c = this.vscode.workspace.getConfiguration('agentSessionRestore');
    return Object.fromEntries(['autoRestore', 'codexCommand', 'piCommand', 'claudeCommand', 'agyCommand', 'codexHome', 'piHome'].map(key => [key, c.get(key)]));
  }

  async save() {
    const snapshot = this.entries.map(entry => ({ ...entry }));
    this.writes = this.writes.catch(() => {}).then(() => this.context.workspaceState.update(STORAGE_KEY, snapshot));
    await this.writes;
    this.changed();
  }

  async add(session, name) {
    const existing = this.entries.find(entry => sessionKey(entry) === sessionKey(session));
    if (existing) return existing;
    const entry = { id: randomUUID(), provider: session.provider, sessionId: session.sessionId,
      sessionFile: session.sessionFile, cwd: session.cwd, name, createdAt: new Date().toISOString() };
    this.entries.push(entry);
    await this.save();
    return entry;
  }

  async startInShell(terminal, entry) {
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
    if (!this.vscode.window.terminals.includes(terminal) || !this.entries.some(item => item.id === entry.id)) return;
    const command = resumeCommand(entry, this.config());
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
      if (entry.automatic) {
        const bound = new Set(this.live.values());
        const revived = this.vscode.window.terminals.find(terminal => !bound.has(terminal) && terminal.name === entry.name && terminal.exitStatus === undefined);
        if (revived) {
          // VS Code revives ordinary terminals as shells. Restore the CLI in that
          // existing tab instead of appending another terminal beside it.
          this.live.set(entry.id, revived);
          await this.startInShell(revived, entry);
          if (reveal) revived.show(true);
          return revived;
        }
      }
      const terminal = this.vscode.window.createTerminal({ ...launchOptions(entry, this.config()), iconPath: new this.vscode.ThemeIcon('history') });
      this.live.set(entry.id, terminal);
      await this.startInShell(terminal, entry);
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
    for (const entry of [...this.entries]) {
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
    for (const [id, live] of this.live) if (live === terminal) this.live.delete(id);
    // Window shutdown also emits terminal-close events. Never erase saved mappings here.
    this.changed();
  }
}

module.exports = { SessionManager, STORAGE_KEY };
