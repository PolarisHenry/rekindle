'use strict';

const vscode = require('vscode');
const { cleanTitle, discoverSessions, isInWorkspace, dispatchFolderAdd } = require('./core');
const { SessionManager } = require('./manager');
const { AutomaticTracker } = require('./automatic');
const { pickConversation } = require('./session-picker');
const { SessionTree } = require('./session-tree');
const { unusedShell, removeStartupShells } = require('./startup');

function activate(context) {
  const output = vscode.window.createOutputChannel('Rekindle');
  let sessionTree;
  const refresh = () => {
    sessionTree?.refresh();
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
  const tracker = new AutomaticTracker(vscode, manager, log, {
    testMode: context.extensionMode === vscode.ExtensionMode.Test || Boolean(process.env.AGENT_RESTORE_TEST_PHASE)
  });
  context.subscriptions.push(tracker);
  sessionTree = new SessionTree(vscode, manager, context, log);
  const view = vscode.window.createTreeView('agentSessionRestore.sessions', {
    treeDataProvider: sessionTree
  });
  sessionTree.attachView(view);
  context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(() => sessionTree.refresh()), vscode.window.onDidChangeActiveTextEditor(() => sessionTree.refresh()));
  context.subscriptions.push(output, sessionTree, view);

  const command = (name, callback) => context.subscriptions.push(vscode.commands.registerCommand(`agentSessionRestore.${name}`, async (...args) => {
    try { return await callback(...args); }
    catch (error) { log(error.stack || error.message); await vscode.window.showErrorMessage(`Rekindle: ${error.message}`); }
  }));

  async function pickEntry(entry) {
    if (entry?.sessionId) return sessionTree.ensureTracked(entry);
    const picked = await vscode.window.showQuickPick(manager.entries.map(saved => ({ label: saved.name, description: saved.provider, detail: saved.cwd, entry: saved })), { title: 'Choose a session' });
    return picked?.entry;
  }

  async function chooseDirectory(folders, suggested) {
    const initial = suggested && typeof suggested === 'string' ? suggested : undefined;
    const choices = [...new Set([initial, ...folders].filter(Boolean))];
    const directory = await vscode.window.showQuickPick([
      ...choices.map(cwd => ({ label: cwd, cwd, description: cwd === initial ? 'Current folder' : undefined })),
      { label: '$(folder-opened) Browse for any folder…', browse: true }
    ], { title: 'Conversation working directory' });
    if (!directory) return;
    if (!directory.browse) return directory.cwd;
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Use Folder' });
    return selected?.[0]?.fsPath;
  }

  command('add', async target => {
    if (!vscode.workspace.workspaceFolders?.length) throw new Error('Open a workspace before adding a session.');
    const provider = await vscode.window.showQuickPick([
      { label: 'Codex', value: 'codex' }, { label: 'pi', value: 'pi' },
      { label: 'Claude Code', value: 'claude' }, { label: 'Antigravity CLI', value: 'agy' }
    ], { title: 'Rekindle: Add Session', placeHolder: 'Choose an agent' });
    if (!provider) return;
    const folders = vscode.workspace.workspaceFolders.filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
    const targetPath = typeof target === 'string' ? target : target?.cwd || target?.uri?.fsPath || target?.fsPath;
    const terminalCwd = vscode.window.activeTerminal?.shellIntegration?.cwd;
    const suggested = targetPath || (terminalCwd?.scheme === 'file' ? terminalCwd.fsPath : undefined);
    const sessions = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Reading saved conversations' }, () => discoverSessions(provider.value, manager.config(), log));
    sessions.sort((a,b) => Number(isInWorkspace(b.cwd,folders))-Number(isInWorkspace(a.cwd,folders)) || b.updatedAt-a.updatedAt);
    const selected = await pickConversation(vscode, provider.label, sessions);
    if (!selected) return;
    let session = selected.session;
    if (!session) {
      let sessionId;
      if (!selected.create) {
        sessionId = await vscode.window.showInputBox({ title: `Add ${provider.label} Session`, prompt: 'Enter the exact ID of an existing saved conversation.', validateInput: value => !value.trim() || /^-/.test(value.trim()) || /[\x00-\x1f]/.test(value) ? 'Enter a valid saved session ID.' : undefined });
        if (!sessionId) return;
      }
      const cwd = await chooseDirectory(folders, suggested);
      if (!cwd) return;
      session = { provider: provider.value, sessionId: sessionId?.trim(), cwd, title: sessionId?.trim() || 'New Session' };
    }
    const name = selected.create && selected.name ? selected.name : await vscode.window.showInputBox({
      title: 'Terminal name', value: selected.create ? '' : `${provider.label} · ${cleanTitle(session.title).slice(0,45)}`,
      validateInput: value => value.trim() ? undefined : 'Enter a name.'
    });
    if (!name?.trim()) return;
    if (selected.create) return manager.create(session, cleanTitle(name));
    const entry = await manager.add(session, cleanTitle(name));
    await manager.setEnabled(entry.id, true);
    await manager.open(entry);
  });
  command('addInFolder', async target => {
    return dispatchFolderAdd(target, (...args) => vscode.commands.executeCommand(...args));
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
    chosen.customName = true;
    await manager.save();
  });
  command('enable', async entry => { const chosen = await pickEntry(entry); if (chosen) await manager.setEnabled(chosen.id, true); });
  command('disable', async entry => { const chosen = await pickEntry(entry); if (chosen) await manager.setEnabled(chosen.id, false); });
  command('search', () => sessionTree.searchSessions());
  command('clearSearch', () => sessionTree.setSearch(''));
  command('showHistory', () => sessionTree.setShowHistory(true));
  command('hideHistory', () => sessionTree.setShowHistory(false));
  command('groupByFolder', () => sessionTree.setGrouping('folder'));
  command('groupByAgent', () => sessionTree.setGrouping('agent'));
  command('showAllFolders', () => sessionTree.setWorkspaceOnly(false));
  command('workspaceOnly', () => sessionTree.setWorkspaceOnly(true));
  command('refreshHistory', async () => { await sessionTree.loadHistory(true); sessionTree.refresh(); });
  command('launchSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-tools.agent-session-restore Arguments'));
  command('logs', () => output.show());
  context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
    if (terminal.exitStatus?.reason === vscode.TerminalExitReason.User) {
      const entry = manager.entries.find(item => manager.live.get(item.id) === terminal);
      if (entry) void manager.setEnabled(entry.id, false);
    }
    tracker.closed(terminal);
    manager.closed(terminal);
  }));
  refresh();

  // Expose readiness for integration tests and other local extension tooling.
  const ready = (async () => {
    let failures;
    try {
      if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length || manager.config().autoRestore === false) return;
      await tracker.sample();
      failures = await tracker.restoreAfterPrepare(() => manager.restore());
      await removeStartupShells(vscode, manager, startupShells, log);
      // hideOnStartup=whenEmpty prevents VS Code from creating a competing shell.
      // If there were no agents (or every restore failed), keep normal terminal UX.
      if (vscode.window.terminals.length === 0) vscode.window.createTerminal().show(false);
      const first = manager.entries.filter(entry => entry.enabled !== false).map(entry => manager.live.get(entry.id)).find(terminal => terminal && terminal.exitStatus === undefined && vscode.window.terminals.includes(terminal));
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
  return { ready, manager, tracker, tree: sessionTree, view };
}

module.exports = { activate };
