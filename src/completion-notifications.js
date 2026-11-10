'use strict';

const CONTEXT_KEY = 'rekindle.completionNotifications';

function notificationsEnabled(vscode) {
  return vscode.workspace.getConfiguration('agentSessionRestore').get('completionNotifications', true);
}

async function setNotificationsEnabled(vscode, enabled) {
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration('agentSessionRestore').update(
    'completionNotifications', enabled, target
  );
  const effective = notificationsEnabled(vscode);
  await vscode.commands.executeCommand('setContext', CONTEXT_KEY, effective);
  return effective;
}

module.exports = { CONTEXT_KEY, notificationsEnabled, setNotificationsEnabled };
