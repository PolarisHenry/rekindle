'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sessionKey, launchOptions, resumeCommand, newSessionCommand, startupArguments, normalizeTimestamp } = require('./core');
const { createAgentTerminal, ShellGate } = require('./python-terminal');
const { retireIdleTerminal } = require('./startup');
const { agentIcon } = require('./agent-icons');
const { dedicatedCodexConfig } = require('./codex-launch');
const { piSessionsRoot, resolvePiSessionFile } = require('./pi-session');
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
    this.liveOnlyEntries = new Map();
    this.liveOnlyByTerminal = new WeakMap();
    this.working = new Set();
    this.status = new Map();
    this.hiddenHistory = new Set(context.workspaceState.get('rekindle.hiddenHistory.v1', []));
    this.opening = new Map();
    this.restarting = new Set();
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

  configFor(entry) {
    const config = this.config();
    if (Array.isArray(entry.sessionArguments)) config[`${entry.provider}Arguments`] = [...entry.sessionArguments];
    return config;
  }

  async launchConfig(entry) {
    const config = this.configFor(entry);
    config.codexDedicatedProcess = this.vscode.workspace.getConfiguration('agentSessionRestore').get('codexDedicatedProcess');
    return entry.provider === 'codex' ? dedicatedCodexConfig(config) : config;
  }

  upsertLiveOnly(terminal, provider, cwd) {
    if (!terminal || provider !== 'codex' || !path.isAbsolute(cwd || '')) return undefined;
    let id = this.liveOnlyByTerminal.get(terminal);
    let entry = id && this.liveOnlyEntries.get(id);
    let changed = false;
    if (!entry) {
      id = `live-only:${randomUUID()}`;
      entry = { id, provider, cwd, name: terminal.name || 'Codex terminal', ephemeral: true, enabled: false };
      this.liveOnlyByTerminal.set(terminal, id);
      this.liveOnlyEntries.set(id, entry);
      changed = true;
    } else if (entry.cwd !== cwd || entry.name !== (terminal.name || 'Codex terminal')) {
      entry.cwd = cwd;
      entry.name = terminal.name || 'Codex terminal';
      changed = true;
    }
    this.live.set(id, terminal);
    if (!this.status.has(id)) {
      this.status.set(id, { state: 'unknown', reason: 'Codex is running, but its shared daemon has not exposed an exact conversation binding. This live terminal can be focused, but it cannot be auto-restored until an exact session is identified.', updatedAt: Date.now() });
      changed = true;
    }
    if (changed) this.changed(id);
    return entry;
  }

  removeLiveOnly(id, refresh = true) {
    if (!this.liveOnlyEntries.has(id)) return false;
    this.liveOnlyEntries.delete(id);
    this.live.delete(id);
    this.working.delete(id);
    this.status.delete(id);
    if (refresh) this.changed(id);
    return true;
  }

  removeLiveOnlyForTerminal(terminal, refresh = true) {
    const id = this.liveOnlyByTerminal.get(terminal);
    return id ? this.removeLiveOnly(id, refresh) : false;
  }

  async save() {
    const snapshot = this.entries.map(entry => ({ ...entry }));
    this.writes = this.writes.catch(() => {}).then(() => this.context.workspaceState.update(STORAGE_KEY, snapshot));
    await this.writes;
    this.changed();
  }

  async add(session, name, enabled = true) {
    if (this.hiddenHistory.delete(sessionKey(session))) await this.context.workspaceState.update('rekindle.hiddenHistory.v1', [...this.hiddenHistory]);
    const existing = this.entries.find(entry => sessionKey(entry) === sessionKey(session));
    if (existing) {
      let dirty = false;
      // Adding a conversation that is already tracked is an explicit rename/update,
      // never a silent no-op. Preserve its restore setting and stable identity.
      if (name && (existing.name !== name || !existing.customName)) { existing.name = name; existing.customName = true; dirty = true; }
      const activityAt = normalizeTimestamp(session.lastActivityAt ?? session.updatedAt);
      if (activityAt && activityAt > (existing.lastActivityAt || 0)) {
        existing.lastActivityAt = activityAt;
        delete existing.activityUnknown;
        dirty = true;
      }
      if (dirty) await this.save();
      return existing;
    }
    const entry = { id: randomUUID(), provider: session.provider, sessionId: session.sessionId,
      sessionFile: session.sessionFile, cwd: session.cwd, name, customName: true, enabled,
      favorite: session.favorite === true,
      ...(Array.isArray(session.sessionArguments) ? { sessionArguments: [...session.sessionArguments] } : {}),
      lastActivityAt: normalizeTimestamp(session.lastActivityAt ?? session.updatedAt) || undefined,
      ...(session.updatedAt == null && session.lastActivityAt == null ? { activityUnknown: true } : {}),
      createdAt: new Date().toISOString() };
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

  async setFavorite(id, favorite) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) return;
    entry.favorite = favorite === true;
    await this.save();
  }

  async setSessionArguments(id, args) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) throw new Error('This session is no longer tracked.');
    if (args !== undefined && !Array.isArray(args)) throw new Error('Session arguments must be a JSON array.');
    if (args !== undefined) startupArguments(entry.provider, { [`${entry.provider}Arguments`]: args });
    if (args === undefined) delete entry.sessionArguments;
    else entry.sessionArguments = [...args];
    await this.save();
  }

  async hideFromHistory(session) {
    if (!session || !session.sessionId || !session.provider) return;
    const tracked = this.entries.find(entry => sessionKey(entry) === sessionKey(session));
    if (tracked && (tracked.enabled !== false || tracked.favorite || this.live.has(tracked.id))) throw new Error('Enabled, favorite, or running sessions are kept visible.');
    const key = sessionKey(session);
    this.hiddenHistory.add(key);
    await this.context.workspaceState.update('rekindle.hiddenHistory.v1', [...this.hiddenHistory]);
    this.changed();
  }

  async hideHistoryEntries(sessions) {
    for (const session of sessions) {
      if (!session?.provider || !session.sessionId) continue;
      const tracked = this.entries.find(entry => sessionKey(entry) === sessionKey(session));
      if (tracked && (tracked.enabled !== false || tracked.favorite || this.live.has(tracked.id))) continue;
      this.hiddenHistory.add(sessionKey(session));
    }
    await this.context.workspaceState.update('rekindle.hiddenHistory.v1', [...this.hiddenHistory]);
    this.changed();
  }

  async unhideSession(session) {
    if (!session?.provider || !session.sessionId) return;
    if (this.hiddenHistory.delete(sessionKey(session))) {
      await this.context.workspaceState.update('rekindle.hiddenHistory.v1', [...this.hiddenHistory]);
      this.changed();
    }
  }

  async resetHiddenHistory() {
    this.hiddenHistory.clear();
    await this.context.workspaceState.update('rekindle.hiddenHistory.v1', []);
    this.changed();
  }

  async markActivity(id, timestamp) {
    const entry = this.entries.find(item => item.id === id);
    const next = normalizeTimestamp(timestamp);
    if (!entry || !next || next <= (entry.lastActivityAt || 0)) return false;
    entry.lastActivityAt = next;
    await this.save();
    return true;
  }

  async markOpened(id, timestamp) {
    const entry = this.entries.find(item => item.id === id);
    const next = normalizeTimestamp(timestamp);
    if (!entry || !next || next <= (entry.lastOpenedAt || 0)) return false;
    entry.lastOpenedAt = next;
    await this.save();
    return true;
  }

  observe(session, terminal, previousId) {
    let entry = this.entries.find(row => row.id === previousId);
    let dirty = false;
    let inherited;
    if (entry && sessionKey(entry) !== sessionKey(session)) {
      if (entry.provider === session.provider) inherited = {
        name: entry.name, customName: entry.customName === true,
        enabled: entry.enabled !== false, favorite: entry.favorite === true,
        ...(entry.sessionArguments !== undefined ? { sessionArguments: [...entry.sessionArguments] } : {})
      };
      entry.enabled = false;
      entry.archived = true;
      this.live.delete(entry.id);
      this.working.delete(entry.id);
      entry = undefined;
      dirty = true;
    }
    if (!entry) entry = this.entries.find(row => sessionKey(row) === sessionKey(session));
    if (!entry) {
      const pending = this.pending.get(previousId);
      const preferences = pending || inherited;
      entry = {
        id: pending ? previousId : randomUUID(),
        ...(preferences ? { name: preferences.name, customName: preferences.customName === true } : {}),
        provider: session.provider, sessionId: session.sessionId, sessionFile: session.sessionFile,
        cwd: session.cwd, enabled: preferences?.enabled ?? true,
        favorite: preferences?.favorite === true,
        ...(preferences?.sessionArguments !== undefined ? { sessionArguments: [...preferences.sessionArguments] } : {}),
        lastActivityAt: normalizeTimestamp(session.lastActivityAt ?? session.updatedAt) || undefined,
        createdAt: pending?.createdAt || new Date().toISOString()
      };
      this.entries.push(entry);
      dirty = true;
    }
    if (inherited) {
      Object.assign(entry, inherited, { archived: false });
      dirty = true;
    }
    this.pending.delete(previousId);
    const values = { provider: session.provider, sessionId: session.sessionId, sessionFile: session.sessionFile, cwd: session.cwd, name: entry.customName ? entry.name : terminal.name, automatic: true, unresolved: false };
    if (Object.keys(values).some(key => entry[key] !== values[key])) { Object.assign(entry, values); dirty = true; }
    const activityAt = normalizeTimestamp(session.activityAt);
    if (activityAt && activityAt > (entry.lastActivityAt || 0)) { entry.lastActivityAt = activityAt; dirty = true; }
    this.live.set(entry.id, terminal);
    return { entry, dirty };
  }

  async create(session, name) {
    if (!this.vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting agents.');
    const entry = { ...session, id: randomUUID(), name, customName: true };
    const config = await this.launchConfig(entry);
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
      this.changed(entry.id);
      await this.startInShell(terminal, entry, command);
      terminal.show(false);
      this.log(`Started new ${entry.provider} session in ${entry.cwd}; waiting for its first saved conversation`);
      return terminal;
    } catch (error) {
      this.pending.delete(entry.id);
      terminal?.dispose();
      this.changed(entry.id);
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
    const command = startupCommand || resumeCommand(entry, await this.launchConfig(entry));
    if (terminal.shellIntegration) terminal.shellIntegration.executeCommand(command);
    else terminal.sendText(command, true);
  }

  async open(entry, reveal = true, updateActivity = true) {
    if (entry.ephemeral) {
      if (!this.vscode.workspace.isTrusted) throw new Error('Trust this workspace before opening agent terminals.');
      const terminal = this.live.get(entry.id);
      if (!terminal || terminal.exitStatus !== undefined || !this.vscode.window.terminals.includes(terminal)) {
        this.removeLiveOnly(entry.id);
        throw new Error('This live Codex terminal is no longer available.');
      }
      if (reveal) terminal.show(false);
      return terminal;
    }
    if (entry.unresolved) throw new Error('Cannot identify this terminal in a shared Codex daemon. Restore skipped to avoid opening the wrong conversation.');
    if (!this.vscode.workspace.isTrusted) throw new Error('Trust this workspace before restoring agent sessions.');
    if (!this.entries.some(item => item.id === entry.id)) throw new Error('This session is no longer tracked.');
    await this.unhideSession(entry);
    const known = this.live.get(entry.id) || this.vscode.window.terminals.find(terminal => terminal.creationOptions.env?.AGENT_SESSION_RESTORE_ID === entry.id);
    if (known && known.exitStatus === undefined && this.vscode.window.terminals.includes(known)) {
      const retrying = this.status.get(entry.id)?.state === 'restore-failed';
      if (retrying) {
        try { await this.startInShell(known, entry); }
        catch (error) {
          this.live.delete(entry.id);
          this.status.set(entry.id, { state: 'restore-failed', reason: error.message, updatedAt: Date.now() });
          this.changed(entry.id);
          throw error;
        }
      }
      this.live.set(entry.id, known);
      if (retrying || !this.status.has(entry.id)) this.status.set(entry.id, { state: 'unknown', reason: 'Waiting for the agent session binding to be identified.', updatedAt: Date.now() });
      if (reveal) known.show(false);
      return known;
    }
    if (this.opening.has(entry.id)) return this.opening.get(entry.id);
    const opening = (async () => {
      const stat = await fs.stat(entry.cwd).catch(() => null);
      if (!stat?.isDirectory()) throw new Error(`Project directory not found: ${entry.cwd}`);
      if (entry.provider === 'pi') {
        const sessionFile = await resolvePiSessionFile({
          sessionId: entry.sessionId,
          cwd: entry.cwd,
          sessionFile: entry.sessionFile,
          sessionRoot: piSessionsRoot(this.configFor(entry))
        });
        if (!sessionFile) throw new Error('The saved pi session file is missing or does not match this session ID and working folder. Restore was skipped to avoid opening a different conversation.');
        if (entry.sessionFile !== sessionFile) {
          entry.sessionFile = sessionFile;
          await this.save();
        }
      }
      // Check again after asynchronous filesystem validation to avoid racing an explicit remove.
      if (!this.entries.some(item => item.id === entry.id)) return;
      let revived;
      if (entry.automatic) {
        const bound = new Set(this.live.values());
        revived = this.vscode.window.terminals.find(terminal => !bound.has(terminal) && terminal.name === entry.name && terminal.exitStatus === undefined);
      }
      let terminal;
      try {
        terminal = await createAgentTerminal(this.vscode, { ...launchOptions(entry, await this.launchConfig(entry)), iconPath: agentIcon(this.vscode, entry.provider) }, this.log, undefined, revived);
        this.live.set(entry.id, terminal);
        this.status.set(entry.id, { state: 'unknown', reason: 'Waiting for the agent session binding to be identified.', updatedAt: Date.now() });
        await this.startInShell(terminal, entry);
        if (updateActivity) await this.markOpened(entry.id, Date.now());
        if (revived && terminal !== revived) await retireIdleTerminal(this.vscode, revived, this.log);
        if (reveal) terminal.show(false);
        this.log(`Started ${entry.provider} session ${entry.sessionId}`);
        this.changed();
        return terminal;
      } catch (error) {
        if (terminal) {
          this.live.delete(entry.id);
          if (terminal !== revived) terminal.dispose();
        }
        throw error;
      }
    })();
    this.opening.set(entry.id, opening);
    try { return await opening; }
    catch (error) {
      this.status.set(entry.id, { state: 'restore-failed', reason: error.message, updatedAt: Date.now() });
      this.changed(entry.id);
      throw error;
    }
    finally { this.opening.delete(entry.id); }
  }

  async restore() {
    const failures = [];
    let first;
    for (const entry of this.entries.filter(item => item.enabled !== false)) {
      try {
        const terminal = await this.open(entry, false, false);
        if (!first && terminal) first = terminal;
      }
      catch (error) { this.status.set(entry.id, { state: 'restore-failed', reason: error.message, updatedAt: Date.now() }); this.changed(entry.id); failures.push({ entry, error }); this.log(`Restore failed: ${entry.name}: ${error.message}`); }
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

  async restart(entry) {
    const current = this.entries.find(item => item.id === entry.id);
    if (!current) throw new Error('This session is no longer tracked.');
    if (current.unresolved) throw new Error('Cannot restart because this terminal is not bound to an exact conversation.');
    const terminal = this.live.get(current.id);
    if (terminal && this.vscode.window.terminals.includes(terminal) && terminal.exitStatus === undefined) {
      this.restarting.add(terminal);
      try {
        terminal.dispose();
        const closed = await new Promise(resolve => {
          let subscription;
          const timer = setTimeout(() => { subscription?.dispose(); resolve(!this.vscode.window.terminals.includes(terminal)); }, 5000);
          subscription = this.vscode.window.onDidCloseTerminal(closedTerminal => {
            if (closedTerminal === terminal) { clearTimeout(timer); subscription.dispose(); resolve(true); }
          });
          if (!this.vscode.window.terminals.includes(terminal)) { clearTimeout(timer); subscription?.dispose(); resolve(true); }
        });
        if (!closed) throw new Error('The selected terminal did not close, so it was not restarted.');
        this.closed(terminal);
      } finally { this.restarting.delete(terminal); }
    }
    return this.open(current, true, true);
  }

  closed(terminal) {
    let didChange = this.removeLiveOnlyForTerminal(terminal, false);
    for (const [id, entry] of this.pending) if (entry.terminal === terminal) { this.pending.delete(id); didChange = true; }
    for (const [id, live] of this.live) if (live === terminal) { this.live.delete(id); this.working.delete(id); this.status.set(id, { state: 'saved', reason: 'The terminal is closed. The saved conversation can be opened again.', updatedAt: Date.now() }); didChange = true; }
    // Window shutdown also emits terminal-close events. Never erase saved mappings here.
    if (didChange) this.changed();
  }
}

module.exports = { SessionManager, STORAGE_KEY };
