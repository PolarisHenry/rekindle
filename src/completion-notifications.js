'use strict';

const CONTEXT_KEY = 'rekindle.completionNotifications';
const LOCATION_CONTEXT_KEY = 'rekindle.completionNotificationLocation';
const LOCATION_SETTING = 'completionNotificationLocation';
const DEFAULT_LOCATION = 'statusBar';
const LOCATIONS = Object.freeze(['statusBar', 'native', 'both']);
const MAX_PENDING = 8;

function notificationsEnabled(vscode) {
  return vscode.workspace.getConfiguration('agentSessionRestore').get('completionNotifications', true) !== false;
}

function completionNotificationLocation(vscode) {
  const value = vscode.workspace.getConfiguration('agentSessionRestore').get(LOCATION_SETTING, DEFAULT_LOCATION);
  return LOCATIONS.includes(value) ? value : DEFAULT_LOCATION;
}

function notificationTargets(vscode) {
  if (!notificationsEnabled(vscode)) return { statusBar: false, native: false };
  const location = completionNotificationLocation(vscode);
  return { statusBar: location === 'statusBar' || location === 'both', native: location === 'native' || location === 'both' };
}

async function updateContext(vscode) {
  await vscode.commands.executeCommand('setContext', CONTEXT_KEY, notificationsEnabled(vscode));
  await vscode.commands.executeCommand('setContext', LOCATION_CONTEXT_KEY, completionNotificationLocation(vscode));
}

async function setNotificationsEnabled(vscode, enabled) {
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration('agentSessionRestore').update('completionNotifications', enabled, target);
  const effective = notificationsEnabled(vscode);
  await updateContext(vscode);
  return effective;
}

async function setCompletionNotificationLocation(vscode, location) {
  if (!LOCATIONS.includes(location)) throw new Error('Choose Status Bar, Native Notification, or Both.');
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration('agentSessionRestore').update(LOCATION_SETTING, location, target);
  await updateContext(vscode);
  return completionNotificationLocation(vscode);
}

function safeTitle(entry) {
  return Array.from(String(entry.name || entry.sessionId || 'Session')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\$\([^)]+\)/g, '')).slice(0, 100).join('');
}

function compactTitle(value, maxWidth = 12) {
  let text = '', width = 0;
  for (const character of value) {
    const next = character.codePointAt(0) > 0x7f ? 2 : 1;
    if (width + next > maxWidth) return text + '…';
    text += character;
    width += next;
  }
  return text;
}

class CompletionStatusBar {
  constructor(vscode, limit = MAX_PENDING) {
    this.vscode = vscode;
    this.limit = limit;
    this.pending = [];
    this.available = true;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'agentSessionRestore.openCompletionStatus';
    this.item.name = 'Rekindle completed sessions';
    this.item.hide();
  }

  add(entry, dedupeKey) {
    if (!entry?.id || !entry.provider || !entry.sessionId || typeof dedupeKey !== 'string') return false;
    if (this.pending.some(item => item.dedupeKey === dedupeKey)) return false;
    const existing = this.pending.findIndex(item => item.id === entry.id && item.provider === entry.provider && item.sessionId === entry.sessionId);
    const item = {
      dedupeKey,
      id: entry.id,
      provider: entry.provider,
      sessionId: entry.sessionId,
      name: safeTitle(entry),
      cwd: typeof entry.cwd === 'string' ? entry.cwd : ''
    };
    if (existing >= 0) this.pending.splice(existing, 1);
    this.pending.push(item);
    if (this.pending.length > this.limit) this.pending.splice(0, this.pending.length - this.limit);
    this.render();
    return true;
  }

  getPending() {
    return this.pending.map(item => ({ ...item }));
  }

  acknowledge(dedupeKey) {
    const previous = this.pending.length;
    this.pending = this.pending.filter(item => item.dedupeKey !== dedupeKey);
    if (this.pending.length !== previous) this.render();
    return this.pending.length !== previous;
  }

  acknowledgeSession(id, provider, sessionId) {
    const previous = this.pending.length;
    this.pending = this.pending.filter(item => !(item.id === id && item.provider === provider && item.sessionId === sessionId));
    if (this.pending.length !== previous) this.render();
    return this.pending.length !== previous;
  }

  setAvailable(available) {
    this.available = available === true;
    if (!this.available) this.pending = [];
    this.render();
  }

  clear() {
    this.pending = [];
    this.render();
  }

  render() {
    void this.vscode.commands.executeCommand('setContext', 'rekindle.hasPendingCompletion', this.pending.length > 0).catch(() => {});
    if (!this.available || this.pending.length === 0) {
      this.item.hide();
      return;
    }
    const count = this.pending.length;
    const latest = this.pending.at(-1);
    const providerName = ({ codex: 'Codex', pi: 'pi', claude: 'Claude', agy: 'AGY' })[latest.provider] || latest.provider;
    const latestName = compactTitle(latest.name);
    this.item.text = `$(check) ${providerName} · ${latestName}${count > 1 ? ` +${count - 1}` : ''}`;
    this.item.tooltip = this.pending.map(item => `${item.provider} · ${item.name} · ${item.cwd.replace(/[\r\n\t]/g, ' ')}`).join('\n');
    this.item.accessibilityInformation = { label: `${count} completed agent session${count === 1 ? '' : 's'}; activate to open` };
    this.item.show();
  }

  dispose() {
    this.clear();
    this.item.dispose();
  }
}

module.exports = {
  CONTEXT_KEY,
  LOCATION_CONTEXT_KEY,
  LOCATION_SETTING,
  DEFAULT_LOCATION,
  LOCATIONS,
  MAX_PENDING,
  notificationsEnabled,
  completionNotificationLocation,
  notificationTargets,
  setNotificationsEnabled,
  setCompletionNotificationLocation,
  updateContext,
  CompletionStatusBar
};
