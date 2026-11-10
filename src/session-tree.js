'use strict';
const path = require('node:path');
const { sessionKey, discoverSessions, isInWorkspace } = require('./core');
const { agentIcon } = require('./agent-icons');
const AGENT_NAMES = { codex: 'Codex', pi: 'pi', claude: 'Claude Code', agy: 'Antigravity CLI' };

function groupedSessions(tracked, history, showHistory, options = {}) {
  const { groupBy = 'folder', workspaceFolders = [], workspaceOnly = true, currentFolder, search = '' } = options;
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const rows = new Map(tracked.map(entry => [sessionKey(entry), entry]));
  if (showHistory) for (const row of history) {
    if (!rows.has(sessionKey(row))) rows.set(sessionKey(row), {
      ...row, id: `history:${sessionKey(row)}`, name: row.title || row.sessionId,
      enabled: false, historyOnly: true
    });
  }
  const priority = entry => {
    const cwd = path.resolve(entry.cwd);
    if (currentFolder && cwd === path.resolve(currentFolder)) return 0;
    if (currentFolder && (isInWorkspace(cwd, [currentFolder]) || isInWorkspace(currentFolder, [cwd]))) return 1;
    return isInWorkspace(cwd, workspaceFolders) ? 2 : 3;
  };
  const groups = new Map();
  for (const entry of rows.values()) {
    if (!showHistory && entry.archived) continue;
    // The normal view is the set that will actually restore on this workspace.
    // Paused and discovered-only conversations are available from Show History.
    if (!showHistory && (entry.historyOnly || entry.enabled === false)) continue;
    const text = [entry.name, entry.title, entry.cwd, entry.sessionId, entry.provider, AGENT_NAMES[entry.provider]].filter(Boolean).join(' ').toLocaleLowerCase();
    if (!terms.every(term => text.includes(term))) continue;
    if (workspaceOnly && workspaceFolders.length && !isInWorkspace(entry.cwd, workspaceFolders)) continue;
    const cwd = path.resolve(entry.cwd);
    const key = groupBy === 'agent' ? entry.provider : cwd;
    if (!groups.has(key)) groups.set(key, groupBy === 'agent'
      ? { kind: 'agent', provider: entry.provider, sessions: [] }
      : { kind: 'folder', cwd, sessions: [] });
    groups.get(key).sessions.push(entry);
  }
  const rank = group => Math.min(...group.sessions.map(priority));
  const label = group => group.kind === 'folder' ? group.cwd : AGENT_NAMES[group.provider] || group.provider;
  const compare = (a,b) => rank(a)-rank(b) || label(a).localeCompare(label(b));
  for (const [key, group] of groups) {
    group.groupId = JSON.stringify([groupBy, key]);
    group.sessions.sort((a,b) => priority(a)-priority(b) || a.name.localeCompare(b.name) || sessionKey(a).localeCompare(sessionKey(b)));
    const children = new Map();
    for (const entry of group.sessions) {
      const cwd = path.resolve(entry.cwd);
      const childKey = group.kind === 'agent' ? cwd : entry.provider;
      if (!children.has(childKey)) children.set(childKey, {
        ...(group.kind === 'agent' ? { kind: 'folder', cwd } : { kind: 'agent', provider: entry.provider }),
        groupId: JSON.stringify([groupBy, key, childKey]), sessions: []
      });
      children.get(childKey).sessions.push(entry);
    }
    group.children = [...children.values()].sort(compare);
  }
  return [...groups.values()].sort(compare);
}

class SessionTree {
  constructor(vscode, manager, context, log) {
    this.vscode = vscode;
    this.manager = manager;
    this.context = context;
    this.log = log;
    this.showHistory = context.workspaceState.get('rekindle.showHistory', false);
    this.groupBy = context.workspaceState.get('rekindle.groupBy', 'folder') === 'agent' ? 'agent' : 'folder';
    this.workspaceOnly = context.workspaceState.get('rekindle.workspaceOnly', true);
    this.events = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.events.event;
    this.search = '';
    this.history = [];
    this.loadedAt = 0;
    void this.syncContext();
  }

  refresh() { this.events.fire(); }

  attachView(view) { this.view = view; void this.syncContext(); }

  async syncContext() {
    if (this.view) this.view.description = `${this.groupBy === 'folder' ? 'By Folder' : 'By Agent'} · ${this.workspaceOnly ? 'Workspace' : 'All Folders'} · ${this.showHistory ? 'History' : 'Tracked'}`;
    await Promise.all([
      ['rekindle.searchActive', Boolean(this.search)],
      ['rekindle.showHistory', this.showHistory],
      ['rekindle.groupBy', this.groupBy],
      ['rekindle.workspaceOnly', this.workspaceOnly]
    ].map(([key, value]) => this.vscode.commands?.executeCommand('setContext', key, value)));
  }

  async setShowHistory(value) {
    this.showHistory = value;
    await this.context.workspaceState.update('rekindle.showHistory', value);
    await this.syncContext();
    this.refresh();
  }

  async setGrouping(value) {
    if (!['folder','agent'].includes(value)) throw new Error('Unknown grouping mode.');
    this.groupBy = value;
    await this.context.workspaceState.update('rekindle.groupBy', value);
    await this.syncContext();
    this.refresh();
  }

  async setWorkspaceOnly(value) {
    this.workspaceOnly = value;
    await this.context.workspaceState.update('rekindle.workspaceOnly', value);
    await this.syncContext();
    this.refresh();
  }

  async setSearch(value) {
    this.search = value.trim();
    await this.syncContext();
    this.refresh();
  }

  async searchSessions() {
    const input = this.vscode.window.createInputBox();
    const previous = this.search;
    input.title = 'Search Sessions';
    input.placeholder = 'Search name, agent, folder, or session ID';
    input.value = previous;
    let accepted = false;
    const subscriptions = [
      input.onDidChangeValue(value => { void this.setSearch(value); }),
      input.onDidAccept(() => { accepted = true; input.hide(); })
    ];
    subscriptions.push(input.onDidHide(() => {
      if (!accepted) void this.setSearch(previous);
      for (const subscription of subscriptions) subscription.dispose();
      input.dispose();
    }));
    input.show();
  }

  displayOptions() {
    const cwd = this.vscode.window.activeTerminal?.shellIntegration?.cwd;
    const editor = this.vscode.window.activeTextEditor?.document?.uri;
    const currentFolder = cwd?.scheme === 'file' ? cwd.fsPath : editor?.scheme === 'file' ? path.dirname(editor.fsPath) : undefined;
    return {
      search: this.search,
      groupBy: this.groupBy,
      workspaceOnly: this.workspaceOnly,
      workspaceFolders: this.vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath) || [],
      currentFolder
    };
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
    if (node?.kind === 'folder' || node?.kind === 'agent') return node.children || node.sessions;
    if (node) return [];
    if (this.showHistory) await this.loadHistory();
    const groups = groupedSessions(this.manager.entries, this.history, this.showHistory, this.displayOptions());
    if (this.view) this.view.message = this.search ? `Search: ${this.search}${groups.length ? '' : ' — No matching sessions.'}` : groups.length ? undefined : 'No matching sessions. Use the … menu to show history or all folders.';
    return groups;
  }

  getTreeItem(node) {
    const v = this.vscode;
    if (node.kind === 'folder' || node.kind === 'agent') {
      const enabled = node.sessions.filter(entry => entry.enabled !== false).length;
      const item = new v.TreeItem(node.kind === 'folder' ? path.basename(node.cwd) || node.cwd : AGENT_NAMES[node.provider] || node.provider, node.sessions.some(entry => !entry.historyOnly) ? v.TreeItemCollapsibleState.Expanded : v.TreeItemCollapsibleState.Collapsed);
      item.id = `group:${node.groupId}`;
      item.description = `${enabled} enabled · ${node.sessions.length} sessions`;
      item.tooltip = node.kind === 'folder' ? node.cwd : AGENT_NAMES[node.provider] || node.provider;
      item.iconPath = node.kind === 'folder' ? new v.ThemeIcon('folder') : agentIcon(v, node.provider);
      item.contextValue = node.kind === 'folder' ? 'sessionFolder' : 'sessionAgent';
      return item;
    }
    const running = this.manager.live.get(node.id);
    const enabled = node.enabled !== false;
    const item = new v.TreeItem(node.name, v.TreeItemCollapsibleState.None);
    item.id = `session:${sessionKey(node)}`;
    const working = this.manager.working?.has(node.id) === true;
    item.description = [node.historyOnly || node.archived ? 'History' : enabled ? '' : 'Auto Restore Off', working && running && v.window.terminals.includes(running) ? 'Working' : ''].filter(Boolean).join(' · ');
    item.tooltip = `${node.provider}\n${node.cwd}\nSession: ${node.sessionId}\n${enabled ? 'Auto restore enabled' : 'Auto restore disabled'}\nClick to open. Use Enable / Disable Auto Restore to change restoration.`;
    item.iconPath = agentIcon(v, node.provider);
    item.contextValue = node.historyOnly ? 'historySession' : enabled ? 'enabledSession' : 'disabledSession';
    item.command = { command: 'agentSessionRestore.open', title: 'Open Session', arguments: [node] };
    return item;
  }

  async ensureTracked(node) {
    return this.manager.entries.find(entry => entry.id === node.id)
      || this.manager.entries.find(entry => sessionKey(entry) === sessionKey(node))
      || this.manager.add(node, node.name, false);
  }

  dispose() { this.events.dispose(); }
}
module.exports = { SessionTree, groupedSessions };
