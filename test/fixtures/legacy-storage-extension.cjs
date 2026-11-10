'use strict';

const vscode = require('vscode');

exports.activate = async function (context) {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) throw new Error('Migration integration fixture requires a folder workspace.');
  const sessions = [
    { id: 'legacy-enabled-id', provider: 'codex', sessionId: 'legacy-enabled-session', cwd, name: 'Legacy custom name', customName: true, enabled: true, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'legacy-disabled-id', provider: 'pi', sessionId: 'legacy-disabled-session', sessionFile: `${cwd}/legacy.pi.jsonl`, cwd, name: 'Paused legacy', customName: true, enabled: false, archived: true, createdAt: '2026-01-02T00:00:00.000Z' }
  ];
  await context.workspaceState.update('agentSessionRestore.sessions.v1', sessions);
  await context.workspaceState.update('rekindle.showHistory', true);
  await context.workspaceState.update('rekindle.groupBy', 'agent');
  await context.workspaceState.update('rekindle.workspaceOnly', false);
  return { seeded: true, count: sessions.length };
};
