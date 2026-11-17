'use strict';

const { sessionKey } = require('./core');
const { t } = require('./localization');

async function selectSession(vscode, manager, tree, target) {
  if (target?.sessionId || target?.ephemeral) return target;
  const selected = tree.view?.selection?.find(item => item?.sessionId || item?.ephemeral);
  if (selected) return selected;
  if (tree.showHistory) await tree.loadHistory();
  const rows = new Map(manager.entries.map(entry => [sessionKey(entry), entry]));
  if (tree.showHistory) for (const entry of tree.history) if (!rows.has(sessionKey(entry))) rows.set(sessionKey(entry), entry);
  const choice = await vscode.window.showQuickPick([...rows.values()].map(entry => ({
    label: entry.name || entry.title || entry.sessionId,
    description: entry.provider,
    detail: entry.cwd,
    entry
  })), { title: t('Choose a session') });
  return choice?.entry;
}

async function showSessionDiagnostics({ vscode, manager, tree, output, entry }) {
  const chosen = await selectSession(vscode, manager, tree, entry);
  if (!chosen) return;
  if (chosen.ephemeral) {
    const status = manager.status.get(chosen.id);
    const reason = status?.reason || t('The Codex process has not exposed an exact conversation binding.');
    const choice = await vscode.window.showInformationMessage(`${chosen.name}\n${t('State: Unknown (live terminal only)')}\n${t('Folder: {0}', [chosen.cwd])}\n${reason}`, t('Open Terminal'), t('Open Logs'));
    if (choice === t('Open Terminal')) await manager.open(chosen, true);
    else if (choice === t('Open Logs')) output.show();
    return;
  }
  const tracked = manager.entries.find(item => item.id === chosen.id)
    || manager.entries.find(item => item.provider === chosen.provider && item.sessionId === chosen.sessionId);
  const status = tracked && manager.status.get(tracked.id);
  const state = status?.state || 'saved';
  const reason = status?.reason || (state === 'saved' ? t('This saved conversation has no currently observed agent process.') : t('No additional diagnostic reason is available.'));
  const stateLabel = ({ saved: 'Saved', working: 'Working', open: 'Open', unknown: 'Unknown', 'restore-failed': 'Restore Failed' })[state] || state;
  const message = `${chosen.provider} · ${chosen.name || chosen.title || chosen.sessionId}\n${t('State: {0}', [t(stateLabel)])}\n${t('Folder: {0}', [chosen.cwd])}\n${reason}`;
  const actions = state === 'restore-failed' ? [t('Retry Restore'), t('Open Logs')] : [t('Open Session'), t('Open Logs')];
  const choice = await vscode.window.showInformationMessage(message, ...actions);
  if (choice === t('Retry Restore') && tracked) await manager.open(tracked, true);
  else if (choice === t('Open Session')) await manager.open(tracked || await tree.ensureTracked(chosen), true);
  else if (choice === t('Open Logs')) output.show();
}

async function openCompletedSession(manager, id, provider, sessionId) {
  const current = manager.entries.find(entry => entry.id === id && entry.provider === provider && entry.sessionId === sessionId);
  if (!current) return;
  return manager.open(current, true);
}

module.exports = { selectSession, showSessionDiagnostics, openCompletedSession };
