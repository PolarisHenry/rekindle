'use strict';

const vscode = require('vscode');
const { cleanTitle } = require('./core');
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
  // Only consider shells present during initial activation, never shells the user
  // deliberately opens later. Empty workspaces keep their normal default shell.
  const startupShells = vscode.window.terminals.filter(unusedShell);
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
    if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length || manager.config().autoRestore === false) return;
    await tracker.sample();
    const failures = await manager.restore();
    await removeStartupShells(vscode, manager, startupShells, log);
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
