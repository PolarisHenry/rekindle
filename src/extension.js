'use strict';

const vscode = require('vscode');
const { cleanTitle, discoverSessions, isInWorkspace } = require('./core');
const { SessionManager } = require('./manager');
const { AutomaticTracker } = require('./automatic');
const { unusedShell, removeStartupShells } = require('./startup');

function activate(context) {
  const output = vscode.window.createOutputChannel('Rekindle');
  const changed = new vscode.EventEmitter();
  const refresh = () => {
    changed.fire();
    void vscode.commands.executeCommand('setContext', 'agentSessionRestore.hasSessions', manager.entries.length > 0);
  };
  const log = message => output.appendLine(`[${new Date().toISOString()}] ${message}`);
  const manager = new SessionManager(vscode, context, log, refresh);
  const startupShells = new Set(vscode.window.terminals.filter(unusedShell));
  // VS Code may open its default shell after extension activation has begun.
  // Observe the restoration phase, not just the initial terminal snapshot.
  const startupListener = vscode.window.onDidOpenTerminal(terminal => {
    if (!terminal.creationOptions.env?.AGENT_SESSION_RESTORE_ID) startupShells.add(terminal);
  });
  context.subscriptions.push(startupListener);
  const tracker = new AutomaticTracker(vscode, manager, log);
  context.subscriptions.push(tracker);
  const tree = {
    onDidChangeTreeData: changed.event,
    getChildren: () => manager.entries,
    getTreeItem(entry) {
      const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
      item.description = entry.provider;
      item.tooltip = `${entry.provider}\n${entry.cwd}\nSession: ${entry.sessionId}\nRestores automatically when this workspace reopens`;
      item.iconPath = new vscode.ThemeIcon('history');
      item.contextValue = 'savedAgentSession';
      item.command = { command: 'agentSessionRestore.open', title: 'Open Session', arguments: [entry] };
      return item;
    }
  };
  context.subscriptions.push(output, changed, vscode.window.registerTreeDataProvider('agentSessionRestore.sessions', tree));

  const command = (name, callback) => context.subscriptions.push(vscode.commands.registerCommand(`agentSessionRestore.${name}`, async (...args) => {
    try { return await callback(...args); }
    catch (error) { log(error.stack || error.message); await vscode.window.showErrorMessage(`Rekindle: ${error.message}`); }
  }));

  async function pickEntry(entry) {
    if (entry?.id) return manager.entries.find(saved => saved.id === entry.id);
    const picked = await vscode.window.showQuickPick(manager.entries.map(saved => ({ label: saved.name, description: saved.provider, detail: saved.cwd, entry: saved })), { title: 'Choose a session' });
    return picked?.entry;
  }

  command('add', async () => {
    if (!vscode.workspace.workspaceFolders?.length) throw new Error('Open a workspace before adding a session.');
    const provider = await vscode.window.showQuickPick([
      { label: 'Codex', value: 'codex' }, { label: 'pi', value: 'pi' },
      { label: 'Claude Code', value: 'claude' }, { label: 'Antigravity CLI', value: 'agy' }
    ], { title: 'Rekindle: Add Session', placeHolder: 'Choose an agent' });
    if (!provider) return;
    let session;
    const folders = vscode.workspace.workspaceFolders.map(folder => folder.uri.fsPath);
    if (['codex', 'pi'].includes(provider.value)) {
      const sessions = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Reading saved conversations' }, () => discoverSessions(provider.value, manager.config(), log));
      sessions.sort((a, b) => Number(isInWorkspace(b.cwd, folders)) - Number(isInWorkspace(a.cwd, folders)) || b.updatedAt - a.updatedAt);
      const selected = await vscode.window.showQuickPick([
        ...sessions.map(row => ({ label: row.title, description: row.cwd, detail: row.sessionId, session: row })),
        { label: '$(edit) Enter a session ID', manual: true }
      ], { title: `Add ${provider.label} Session`, matchOnDescription: true, matchOnDetail: true });
      if (!selected) return;
      session = selected.session;
    }
    if (!session) {
      const sessionId = await vscode.window.showInputBox({ title: `Add ${provider.label} Session`, prompt: 'Enter the exact ID of an existing saved conversation.', validateInput: value => !value.trim() || /^-/.test(value.trim()) || /[\x00-\x1f]/.test(value) ? 'Enter a valid saved session ID.' : undefined });
      if (!sessionId) return;
      const directory = await vscode.window.showQuickPick([
        ...folders.map(cwd => ({ label: cwd, cwd })), { label: '$(folder-opened) Browse for a project folder', browse: true }
      ], { title: 'Conversation working directory' });
      if (!directory) return;
      let cwd = directory.cwd;
      if (directory.browse) {
        const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Use Folder' });
        cwd = selected?.[0]?.fsPath;
      }
      if (!cwd) return;
      session = { provider: provider.value, sessionId: sessionId.trim(), cwd, title: sessionId.trim() };
    }
    const name = await vscode.window.showInputBox({ title: 'Terminal name', value: `${provider.label} · ${cleanTitle(session.title).slice(0, 45)}`, validateInput: value => value.trim() ? undefined : 'Enter a name.' });
    if (!name) return;
    const entry = await manager.add(session, cleanTitle(name));
    await manager.open(entry);
  });

  command('open', async entry => { const chosen = await pickEntry(entry); if (chosen) await manager.open(chosen); });
  command('restore', async () => {
    const failures = await manager.restore();
    if (failures.length) await vscode.window.showWarningMessage(`${failures.length} session(s) could not be restored. See logs for details.`, 'Show Logs').then(choice => { if (choice) output.show(); });
  });
  command('remove', async entry => {
    const chosen = await pickEntry(entry);
    if (!chosen) return;
    await manager.remove(chosen.id);
    await vscode.window.showInformationMessage(`Stopped restoring "${chosen.name}". Its terminal and conversation history are unchanged.`);
  });
  command('rename', async entry => {
    const chosen = await pickEntry(entry);
    if (!chosen) return;
    const name = await vscode.window.showInputBox({ title: 'Rename Terminal (applies next time)', value: chosen.name, validateInput: value => value.trim() ? undefined : 'Enter a name' });
    if (!name) return;
    chosen.name = cleanTitle(name);
    await manager.save();
  });
  command('logs', () => output.show());
  context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
    if (terminal.exitStatus?.reason === vscode.TerminalExitReason.User) {
      const entry = manager.entries.find(item => item.automatic && manager.live.get(item.id) === terminal);
      if (entry) void manager.remove(entry.id);
    }
    manager.closed(terminal);
  }));
  refresh();

  // Expose readiness for integration tests and other local extension tooling.
  const ready = (async () => {
    let failures;
    try {
      if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length || manager.config().autoRestore === false) return;
      await tracker.sample();
      failures = await manager.restore();
      await removeStartupShells(vscode, manager, startupShells, log);
      // hideOnStartup=whenEmpty prevents VS Code from creating a competing shell.
      // If there were no agents (or every restore failed), keep normal terminal UX.
      if (vscode.window.terminals.length === 0) vscode.window.createTerminal().show(false);
      const first = manager.entries.map(entry => manager.live.get(entry.id)).find(terminal => terminal && terminal.exitStatus === undefined && vscode.window.terminals.includes(terminal));
      if (first) first.show(false);
    } finally {
      startupListener.dispose();
    }
    if (context.extensionMode !== vscode.ExtensionMode.Test && !process.env.AGENT_RESTORE_TEST_PHASE) {
      void tracker.start().catch(error => log(`Observer setup failed: ${error.message}`));
    }
    if (failures.length) {
      void vscode.window.showWarningMessage(`${failures.length} session(s) could not be restored.`, 'Show Logs').then(choice => { if (choice) output.show(); });
    }
  })();
  return { ready, manager, tracker };
}

module.exports = { activate };
