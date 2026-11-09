'use strict';
const path = require('node:path');
const { sessionKey, discoverSessions } = require('./core');

function groupedSessions(tracked, history, showHistory) {
  const rows = new Map(tracked.map(entry => [sessionKey(entry), entry]));
  if (showHistory) for (const row of history) {
    if (!rows.has(sessionKey(row))) rows.set(sessionKey(row), {
      ...row, id: `history:${sessionKey(row)}`, name: row.title || row.sessionId,
      enabled: false, historyOnly: true
    });
  }
  const folders = new Map();
  for (const entry of rows.values()) {
    if (!showHistory && entry.enabled === false) continue;
    const cwd = path.resolve(entry.cwd);
    if (!folders.has(cwd)) folders.set(cwd, { kind: 'folder', cwd, sessions: [] });
    folders.get(cwd).sessions.push(entry);
  }
  for (const folder of folders.values()) folder.sessions.sort((a,b) => Number(b.enabled !== false)-Number(a.enabled !== false) || a.name.localeCompare(b.name));
  return [...folders.values()].sort((a,b) => a.cwd.localeCompare(b.cwd));
}

class SessionTree {
  constructor(vscode, manager, context, log) {
    this.vscode = vscode;
    this.manager = manager;
    this.context = context;
    this.log = log;
    this.showHistory = context.workspaceState.get('rekindle.showHistory', false);
    this.filter = { kind: 'filter' };
    this.events = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.events.event;
    this.history = [];
    this.loadedAt = 0;
  }

  refresh() { this.events.fire(); }

  async setShowHistory(value) {
    this.showHistory = value;
    await this.context.workspaceState.update('rekindle.showHistory', value);
    this.refresh();
  }

  async loadHistory(force = false) {
    if (!force && Date.now() - this.loadedAt < 30000) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const results = await Promise.allSettled(['codex','pi','claude','agy'].map(provider => discoverSessions(provider, this.manager.config(), this.log)));
      this.history = results.flatMap(result => {
        if (result.status === 'fulfilled') return result.value;
        this.log(`History: ${result.reason.message}`);
        return [];
      });
      this.loadedAt = Date.now();
    })();
    try { await this.loading; } finally { this.loading = undefined; }
  }

  async getChildren(node) {
    if (node?.kind === 'folder') return node.sessions;
    if (node) return [];
    if (this.showHistory) await this.loadHistory();
    return [this.filter, ...groupedSessions(this.manager.entries, this.history, this.showHistory)];
  }

  getTreeItem(node) {
    const v = this.vscode;
    if (node.kind === 'filter') {
      const item = new v.TreeItem('Show history', v.TreeItemCollapsibleState.None);
      item.id = 'rekindle:history-filter';
      item.checkboxState = this.showHistory ? v.TreeItemCheckboxState.Checked : v.TreeItemCheckboxState.Unchecked;
      item.tooltip = 'Include paused sessions and conversations saved by your agent CLIs.';
      item.contextValue = 'historyFilter';
      return item;
    }
    if (node.kind === 'folder') {
      const enabled = node.sessions.filter(entry => entry.enabled !== false).length;
      const item = new v.TreeItem(path.basename(node.cwd) || node.cwd, enabled ? v.TreeItemCollapsibleState.Expanded : v.TreeItemCollapsibleState.Collapsed);
      item.id = `folder:${node.cwd}`;
      item.description = `${enabled} enabled · ${node.sessions.length} sessions`;
      item.tooltip = node.cwd;
      item.iconPath = new v.ThemeIcon('folder');
      item.contextValue = 'sessionFolder';
      return item;
    }
    const running = this.manager.live.get(node.id);
    const enabled = node.enabled !== false;
    const item = new v.TreeItem(node.name, v.TreeItemCollapsibleState.None);
    item.id = `session:${sessionKey(node)}`;
    item.description = `${node.provider} · ${enabled ? 'Enabled' : 'History'}${running && v.window.terminals.includes(running) ? ' · Running' : ''}`;
    item.checkboxState = enabled ? v.TreeItemCheckboxState.Checked : v.TreeItemCheckboxState.Unchecked;
    item.tooltip = `${node.provider}\n${node.cwd}\nSession: ${node.sessionId}\n${enabled ? 'Auto restore enabled' : 'Auto restore disabled'}\nClick to open. Check to enable automatic restoration.`;
    item.iconPath = new v.ThemeIcon(enabled ? 'terminal' : 'history');
    item.contextValue = node.historyOnly ? 'historySession' : enabled ? 'enabledSession' : 'disabledSession';
    item.command = { command: 'agentSessionRestore.open', title: 'Open Session', arguments: [node] };
    return item;
  }

  async checked(event) {
    for (const [node, state] of event.items) {
      const enabled = state === this.vscode.TreeItemCheckboxState.Checked;
      if (node.kind === 'filter') await this.setShowHistory(enabled);
      else if (!node.kind) {
        const entry = await this.ensureTracked(node);
        await this.manager.setEnabled(entry.id, enabled);
      }
    }
  }

  async ensureTracked(node) {
    return this.manager.entries.find(entry => entry.id === node.id)
      || this.manager.entries.find(entry => sessionKey(entry) === sessionKey(node))
      || this.manager.add(node, node.name, false);
  }

  dispose() { this.events.dispose(); }
}
module.exports = { SessionTree, groupedSessions };
