'use strict';

const path = require('node:path');
const vscode = require('vscode');
const { cleanTitle, discoverSessions, isInWorkspace, dispatchFolderAdd, resumeCommand } = require('./core');
const { SessionManager } = require('./manager');
const { AutomaticTracker } = require('./automatic');
const { pickConversation } = require('./session-picker');
const { resolveAddContext, chooseProvider, dispatchAddHere, resolveWorkingDirectory, chooseDirectoryWithPicker } = require('./session-add');
const { SessionTree } = require('./session-tree');
const { unusedShell, removeStartupShells } = require('./startup');
const { importLegacySnapshot, OLD_EXTENSION_ID, BRIDGE_VERSION, compareVersions } = require('./migration');
const {
  CompletionStatusBar,
  notificationTargets,
  setNotificationsEnabled,
  setCompletionNotificationLocation,
  updateContext: updateNotificationContext
} = require('./completion-notifications');
const { selectSession, showSessionDiagnostics, openCompletedSession } = require('./session-actions');

async function activate(context) {
  const legacyExtension = vscode.extensions?.getExtension(OLD_EXTENSION_ID);
  if (legacyExtension && compareVersions(legacyExtension.packageJSON?.version, BRIDGE_VERSION) < 0) {
    const reason = `Update ${OLD_EXTENSION_ID} ${legacyExtension.packageJSON?.version || ''} to the passive migration bridge, then reload VS Code.`;
    void vscode.window.showWarningMessage(`Rekindle has paused to avoid loading two copies of its commands. ${reason}`);
    return { ready: Promise.resolve(), blocked: true };
  }
  let migrationResult = { status: 'not-installed' };
  if (legacyExtension && vscode.workspace.workspaceFolders?.length) {
    migrationResult = await importLegacySnapshot({ context, vscode, log: message => console.warn(`[Rekindle] ${message}`) });
    if (migrationResult.status.startsWith('blocked-') && migrationResult.status !== 'blocked-workspace-mismatch') {
      void vscode.window.showWarningMessage('Rekindle paused to avoid duplicate session restoration. Install the Rekindle Legacy Migration bridge over the old extension and reload VS Code.');
      return { ready: Promise.resolve(), blocked: true, migration: migrationResult };
    }
    if (migrationResult.status === 'blocked-workspace-mismatch') {
      void vscode.window.showWarningMessage('Rekindle could not import legacy sessions because the workspace identity did not match. The old bridge remains passive; existing new-identity sessions are unchanged.');
    }
  }
  const output = vscode.window.createOutputChannel('Rekindle');
  let sessionTree;
  const refresh = id => {
    const entry = id && manager?.entries.find(item => item.id === id);
    sessionTree?.refresh(entry);
    void vscode.commands.executeCommand('setContext', 'agentSessionRestore.hasSessions', manager.entries.length + (manager.liveOnlyEntries?.size || 0) > 0);
  };
  const log = message => output.appendLine(`[${new Date().toISOString()}] ${message}`);
  if (migrationResult.status === 'imported' || migrationResult.status === 'recovered-import') log(`Imported ${context.workspaceState.get('agentSessionRestore.sessions.v1', []).length} legacy session record(s).`);
  if (migrationResult.status === 'skipped-existing-data') log('Legacy session import skipped because this extension identity already has session data.');
  const manager = new SessionManager(vscode, context, log, refresh);
  const completionStatusBar = new CompletionStatusBar(vscode);
  context.subscriptions.push(completionStatusBar);
  const syncNotificationSettings = () => {
    completionStatusBar.setAvailable(notificationTargets(vscode).statusBar);
    void updateNotificationContext(vscode);
  };
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('agentSessionRestore.completionNotifications')
      || event.affectsConfiguration('agentSessionRestore.completionNotificationLocation')) syncNotificationSettings();
    if (event.affectsConfiguration('agentSessionRestore.sessionPulse') || event.affectsConfiguration('workbench.reduceMotion')) sessionTree?.refresh();
  }));
  syncNotificationSettings();
  const startupShells = new Set(vscode.window.terminals.filter(unusedShell));
  // VS Code may open its default shell after extension activation has begun.
  // Observe the restoration phase, not just the initial terminal snapshot.
  const startupListener = vscode.window.onDidOpenTerminal(terminal => {
    if (!terminal.creationOptions.env?.AGENT_SESSION_RESTORE_ID) startupShells.add(terminal);
  });
  context.subscriptions.push(startupListener);
  const tracker = new AutomaticTracker(vscode, manager, log, {
    testMode: context.extensionMode === vscode.ExtensionMode.Test || Boolean(process.env.AGENT_RESTORE_TEST_PHASE),
    completionStatusBar
  });
  context.subscriptions.push(tracker);
  sessionTree = new SessionTree(vscode, manager, context, log);
  const view = vscode.window.createTreeView('agentSessionRestore.sessions', {
    treeDataProvider: sessionTree
  });
  sessionTree.attachView(view);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => sessionTree.refresh()));
  context.subscriptions.push(output, sessionTree, view);

  const command = (name, callback) => context.subscriptions.push(vscode.commands.registerCommand(`agentSessionRestore.${name}`, async (...args) => {
    try { return await callback(...args); }
    catch (error) { log(error.stack || error.message); await vscode.window.showErrorMessage(`Rekindle: ${error.message}`); }
  }));

  async function pickEntry(entry) {
    if (entry?.ephemeral) return entry;
    if (entry?.sessionId) return sessionTree.ensureTracked(entry);
    const picked = await vscode.window.showQuickPick(manager.entries.map(saved => ({ label: saved.name, description: saved.provider, detail: saved.cwd, entry: saved })), { title: 'Choose a session' });
    return picked?.entry;
  }

  function findEntry(entry) {
    if (!entry?.sessionId) return undefined;
    return manager.entries.find(saved => saved.id === entry.id)
      || manager.entries.find(saved => saved.provider === entry.provider && saved.sessionId === entry.sessionId)
      || entry;
  }

  const RECENT_FOLDERS_KEY = 'rekindle.recentFolders.v1';
  const loadRecentFolders = () => {
    const value = context.workspaceState.get(RECENT_FOLDERS_KEY, []);
    return Array.isArray(value) ? value.filter(item => typeof item === 'string' && path.isAbsolute(item)) : [];
  };
  const rememberRecentFolder = async (cwd, folders) => {
    if (!path.isAbsolute(cwd || '') || folders.includes(cwd)) return;
    const recent = [cwd, ...loadRecentFolders().filter(item => item !== cwd)].slice(0, 5);
    await context.workspaceState.update(RECENT_FOLDERS_KEY, recent);
  };

  async function chooseDirectory(folders, suggested) {
    const terminalCwd = vscode.window.activeTerminal?.shellIntegration?.cwd;
    const active = terminalCwd?.scheme === 'file' ? terminalCwd.fsPath : undefined;
    return chooseDirectoryWithPicker(vscode, {
      folders,
      suggested,
      active,
      recent: loadRecentFolders(),
      openDialog: async defaultFolder => (await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Use Folder',
        defaultUri: defaultFolder ? vscode.Uri.file(defaultFolder) : undefined
      }))?.[0]?.fsPath
    });
  }

  command('add', async target => {
    if (!vscode.workspace.workspaceFolders?.length) throw new Error('Open a workspace before adding a session.');
    const addContext = resolveAddContext(target);
    const provider = await chooseProvider(vscode, addContext);
    if (!provider) return;
    const folders = vscode.workspace.workspaceFolders.filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
    // Only an explicit context (group +, Explorer) may preselect a folder. The active
    // terminal folder is merely listed, keeping the toolbar action isolated.
    const suggested = addContext.cwd;
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
      const cwd = await resolveWorkingDirectory({ cwd: addContext.cwd, folders, suggested, chooseDirectory });
      if (!cwd) return;
      await rememberRecentFolder(cwd, folders);
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
  command('addHere', async target => dispatchAddHere(target, (...args) => vscode.commands.executeCommand(...args)));

  command('openCompletedSession', async (id, provider, sessionId) => {
    const stillTracked = manager.entries.some(entry => entry.id === id && entry.provider === provider && entry.sessionId === sessionId);
    if (!stillTracked) {
      completionStatusBar.acknowledgeSession(id, provider, sessionId);
      return;
    }
    const terminal = await openCompletedSession(manager, id, provider, sessionId);
    if (terminal) completionStatusBar.acknowledgeSession(id, provider, sessionId);
    return terminal;
  });
  command('openCompletionStatus', async () => {
    const pending = completionStatusBar.getPending();
    const valid = pending.filter(item => manager.entries.some(entry => entry.id === item.id && entry.provider === item.provider && entry.sessionId === item.sessionId));
    for (const item of pending) if (!valid.includes(item)) completionStatusBar.acknowledge(item.dedupeKey);
    if (!valid.length) return;
    let selected = valid[0];
    if (valid.length > 1) {
      const choice = await vscode.window.showQuickPick(valid.map(item => ({
        label: `${item.provider} · ${item.name}`,
        description: path.basename(item.cwd || ''),
        detail: item.cwd,
        item
      })), { title: 'Completed Sessions' });
      selected = choice?.item;
    }
    if (!selected) return;
    const terminal = await openCompletedSession(manager, selected.id, selected.provider, selected.sessionId);
    if (terminal) completionStatusBar.acknowledgeSession(selected.id, selected.provider, selected.sessionId);
  });
  command('clearCompletionStatus', () => completionStatusBar.clear());
  command('open', async entry => {
    const chosen = await pickEntry(entry);
    if (!chosen) return;
    const terminal = await manager.open(chosen);
    if (terminal) completionStatusBar.acknowledgeSession(chosen.id, chosen.provider, chosen.sessionId);
  });
  command('retryRestore', async entry => { const chosen = await pickEntry(entry); if (chosen) await manager.open(chosen, true); });
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
  command('editSessionArguments', async entry => {
    const chosen = await selectSession(vscode, manager, sessionTree, entry);
    const existing = chosen && (manager.entries.find(item => item.id === chosen.id)
      || manager.entries.find(item => item.provider === chosen.provider && item.sessionId === chosen.sessionId));
    if (!chosen) return;
    const mode = await vscode.window.showQuickPick([
      { label: 'Inherit global arguments', value: 'inherit', description: 'Follow Rekindle launch settings.' },
      { label: 'Set arguments for this session…', value: 'override', description: 'Enter a JSON array; [] explicitly disables global arguments.' }
    ], { title: `${chosen.name} Arguments` });
    if (!mode) return;
    if (mode.value === 'inherit') { if (existing) await manager.setSessionArguments(existing.id, undefined); return; }
    const current = Array.isArray(chosen.sessionArguments) ? JSON.stringify(chosen.sessionArguments) : '[]';
    const raw = await vscode.window.showInputBox({
      title: `${chosen.name} Arguments`, prompt: 'Enter a JSON array of individual arguments, e.g. ["--model","o3"].', value: current,
      validateInput: value => {
        try {
          const parsed = JSON.parse(value);
          if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string' || /[\0\r\n]/.test(item))) return 'Enter a JSON array of single-line strings.';
          const config = { [`${chosen.provider}Arguments`]: parsed };
          require('./core').startupArguments(chosen.provider, config);
          return undefined;
        } catch { return 'Enter valid JSON containing an array of strings.'; }
      }
    });
    if (raw !== undefined) {
      const tracked = existing || await sessionTree.ensureTracked(chosen);
      await manager.setSessionArguments(tracked.id, JSON.parse(raw));
    }
  });
  command('openWorkingFolder', async entry => {
    const chosen = await selectSession(vscode, manager, sessionTree, entry);
    if (chosen?.cwd) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(chosen.cwd), { forceNewWindow: true });
  });
  command('copyResumeCommand', async entry => {
    const chosen = await selectSession(vscode, manager, sessionTree, entry);
    if (!chosen) return;
    await vscode.env.clipboard.writeText(resumeCommand(chosen, manager.configFor(chosen)));
    await vscode.window.showInformationMessage('Resume command copied to the clipboard.');
  });
  command('restart', async entry => {
    const chosen = await pickEntry(entry);
    if (chosen) await manager.restart(chosen);
  });
  command('favorite', async entry => {
    const selected = await selectSession(vscode, manager, sessionTree, entry);
    if (selected) {
      const chosen = await sessionTree.ensureTracked(selected);
      await manager.setFavorite(chosen.id, true);
    }
  });
  command('unfavorite', async entry => {
    const selected = await selectSession(vscode, manager, sessionTree, entry);
    const chosen = selected && findEntry(selected);
    if (chosen && manager.entries.some(item => item.id === chosen.id)) await manager.setFavorite(chosen.id, false);
  });
  command('hideHistoryEntry', async entry => {
    const chosen = await selectSession(vscode, manager, sessionTree, entry);
    if (chosen) await sessionTree.hideHistoryEntry(chosen);
  });
  command('hideInactiveHistory', async () => {
    const count = await sessionTree.hideInactiveHistory();
    await vscode.window.showInformationMessage(`Hidden ${count} inactive history records. Originals are untouched; use Reset Hidden History to restore them.`);
  });
  command('resetHiddenHistory', async () => {
    await manager.resetHiddenHistory();
    await vscode.window.showInformationMessage('Hidden history is visible again.');
  });
  command('historyRange1', () => sessionTree.setHistoryRange(1));
  command('historyRange3', () => sessionTree.setHistoryRange(3));
  command('historyRange7', () => sessionTree.setHistoryRange(7));
  command('historyRange15', () => sessionTree.setHistoryRange(15));
  command('historyRange30', () => sessionTree.setHistoryRange(30));
  command('historyRangeAll', () => sessionTree.setHistoryRange('all'));
  command('historyRangeCustom', () => sessionTree.setCustomHistoryRange());
  command('diagnostics', entry => showSessionDiagnostics({ vscode, manager, tree: sessionTree, output, entry }));
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
  command('launchSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id} Arguments`));
  command('enableCompletionNotifications', async () => {
    await setNotificationsEnabled(vscode, true);
    syncNotificationSettings();
    vscode.window.setStatusBarMessage?.('Completion reminders enabled', 2500);
  });
  command('disableCompletionNotifications', async () => {
    await setNotificationsEnabled(vscode, false);
    completionStatusBar.clear();
    completionStatusBar.setAvailable(false);
    vscode.window.setStatusBarMessage?.('Completion reminders disabled', 2500);
  });
  command('completionLocationStatusBar', async () => {
    await setCompletionNotificationLocation(vscode, 'statusBar');
    syncNotificationSettings();
    vscode.window.setStatusBarMessage?.('Completion reminders: Status Bar', 2500);
  });
  command('completionLocationNative', async () => {
    await setCompletionNotificationLocation(vscode, 'native');
    syncNotificationSettings();
    vscode.window.setStatusBarMessage?.('Completion reminders: Native Notification', 2500);
  });
  command('completionLocationBoth', async () => {
    await setCompletionNotificationLocation(vscode, 'both');
    syncNotificationSettings();
    vscode.window.setStatusBarMessage?.('Completion reminders: Both', 2500);
  });
  command('logs', () => output.show());
  context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
    if (terminal.exitStatus?.reason === vscode.TerminalExitReason.User && !manager.restarting.has(terminal)) {
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
      if (!vscode.workspace.workspaceFolders?.length) return;
      if (!vscode.workspace.isTrusted || manager.config().autoRestore === false) return;
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
  return { ready, manager, tracker, tree: sessionTree, view, migration: migrationResult };
}

module.exports = { activate };
