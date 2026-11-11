'use strict';
const path = require('node:path');
const { sessionKey, discoverSessions, isInWorkspace, normalizeTimestamp } = require('./core');
const { agentIcon, sessionIcon } = require('./agent-icons');
const AGENT_NAMES = { codex: 'Codex', pi: 'pi', claude: 'Claude Code', agy: 'Antigravity' };
function rowKey(entry) { return entry.ephemeral ? `live:${entry.id}` : entry.pendingStart ? `pending:${entry.id}` : sessionKey(entry); }

function activityTime(entry) {
  const activity = Math.max(0, ...[entry.lastActivityAt, entry.updatedAt].map(normalizeTimestamp));
  if (activity) return activity;
  return entry.activityUnknown ? 0 : normalizeTimestamp(entry.createdAt);
}

function groupedSessions(tracked, history, showHistory, options = {}) {
  const { groupBy = 'folder', workspaceFolders = [], workspaceOnly = true, currentFolder, search = '', hiddenHistory = new Set(), historyRangeDays = 'all', now = Date.now() } = options;
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const rows = new Map(tracked.map(entry => [rowKey(entry), entry]));
  if (showHistory) for (const row of history) {
    if (hiddenHistory.has(rowKey(row))) continue;
    if (!rows.has(rowKey(row))) rows.set(rowKey(row), {
      ...row, id: `history:${sessionKey(row)}`, name: row.title || row.sessionId,
      enabled: false, historyOnly: true
    });
  }
  const withinHistoryRange = entry => {
    if (entry.ephemeral) return true;
    const excludedByHistory = entry.historyOnly || entry.archived || entry.enabled === false;
    if (!showHistory || !excludedByHistory || historyRangeDays === 'all') return true;
    // Explicit opening can reveal an old history row without changing its sort rank.
    const time = Math.max(activityTime(entry), normalizeTimestamp(entry.lastOpenedAt));
    return time > 0 && time >= now - historyRangeDays * 86400000;
  };
  const priority = entry => {
    const cwd = path.resolve(entry.cwd);
    if (currentFolder && cwd === path.resolve(currentFolder)) return 0;
    if (currentFolder && (isInWorkspace(cwd, [currentFolder]) || isInWorkspace(currentFolder, [cwd]))) return 1;
    return isInWorkspace(cwd, workspaceFolders) ? 2 : 3;
  };
  const groups = new Map();
  for (const entry of rows.values()) {
    if (hiddenHistory.has(rowKey(entry)) && (entry.historyOnly || entry.archived || entry.enabled === false)) continue;
    if (!showHistory && entry.archived) continue;
    // The normal view is the set that will actually restore on this workspace.
    // Paused and discovered-only conversations are available from Show History.
    if (!showHistory && (entry.historyOnly || (entry.enabled === false && !entry.ephemeral))) continue;
    if (!withinHistoryRange(entry)) continue;
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
  const latest = group => Math.max(...group.sessions.map(activityTime));
  const favorite = group => group.sessions.some(entry => entry.favorite === true);
  const label = group => group.kind === 'folder' ? group.cwd : AGENT_NAMES[group.provider] || group.provider;
  const compare = (a,b) => rank(a)-rank(b) || Number(favorite(b))-Number(favorite(a)) || latest(b)-latest(a) || label(a).localeCompare(label(b)) || a.groupId?.localeCompare(b.groupId || '') || '';
  const compareSessions = (a,b) => Number(b.favorite === true)-Number(a.favorite === true) || activityTime(b)-activityTime(a) || rowKey(a).localeCompare(rowKey(b));
  for (const [key, group] of groups) {
    group.groupId = JSON.stringify([groupBy, key]);
    group.sessions.sort(compareSessions);
    const children = new Map();
    for (const entry of group.sessions) {
      const cwd = path.resolve(entry.cwd);
      const childKey = group.kind === 'agent' ? cwd : entry.provider;
      if (!children.has(childKey)) children.set(childKey, {
        ...(group.kind === 'agent' ? { kind: 'folder', cwd, provider: group.provider } : { kind: 'agent', provider: entry.provider, cwd: group.cwd }),
        groupId: JSON.stringify([groupBy, key, childKey]), sessions: []
      });
      children.get(childKey).sessions.push(entry);
    }
    for (const child of children.values()) child.sessions.sort(compareSessions);
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
    this.historyRangeDays = context.workspaceState.get('rekindle.historyRangeDays', vscode.workspace.getConfiguration('agentSessionRestore').get('historyRangeDays', 30));
    this.expandedGroups = new Map(context.workspaceState.get(`rekindle.expandedGroups.${this.groupBy}`, []));
    this.events = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.events.event;
    this.search = '';
    this.history = [];
    this.loadedAt = 0;
    void this.syncContext();
  }

  refresh(element) { this.events.fire(element); void this.syncContext(); }

  attachView(view) {
    this.view = view;
    if (view.onDidExpandElement) this.context.subscriptions?.push(view.onDidExpandElement(event => this.setExpanded(event.element, true)));
    if (view.onDidCollapseElement) this.context.subscriptions?.push(view.onDidCollapseElement(event => this.setExpanded(event.element, false)));
    void this.syncContext();
  }

  async setExpanded(node, expanded) {
    if (!node?.groupId) return;
    this.expandedGroups.set(node.groupId, expanded);
    await this.context.workspaceState.update(`rekindle.expandedGroups.${this.groupBy}`, [...this.expandedGroups]);
  }

  async syncContext() {
    if (this.view) this.view.description = `${this.groupBy === 'folder' ? 'By Folder' : 'By Agent'} · ${this.workspaceOnly ? 'Workspace' : 'All Folders'} · ${this.showHistory ? `History ${this.historyRangeDays === 'all' ? 'All' : `${this.historyRangeDays}d`}` : 'Tracked'}`;
    await Promise.all([
      ['rekindle.searchActive', Boolean(this.search)],
      ['rekindle.showHistory', this.showHistory],
      ['rekindle.groupBy', this.groupBy],
      ['rekindle.workspaceOnly', this.workspaceOnly],
      ['rekindle.historyRangeDays', this.historyRangeDays],
      ['rekindle.hasHiddenHistory', this.manager.hiddenHistory.size > 0]
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
    this.expandedGroups = new Map(this.context.workspaceState.get(`rekindle.expandedGroups.${value}`, []));
    await this.context.workspaceState.update('rekindle.groupBy', value);
    await this.syncContext();
    this.refresh();
  }

  async setHistoryRange(value) {
    if (value !== 'all' && (!Number.isInteger(value) || value < 1 || value > 36500)) throw new Error('History range must be All or a whole number from 1 to 36500 days.');
    this.historyRangeDays = value;
    await this.context.workspaceState.update('rekindle.historyRangeDays', value);
    await this.syncContext();
    this.refresh();
  }

  async hideHistoryEntry(node) {
    if (!node?.provider || !node.sessionId) return;
    const tracked = this.manager.entries.find(entry => sessionKey(entry) === sessionKey(node));
    if (tracked && (tracked.enabled !== false || tracked.favorite || this.manager.live.has(tracked.id))) throw new Error('Enabled, favorite, or running sessions are kept visible. Disable or unfavorite it first.');
    await this.manager.hideFromHistory(node);
    this.refresh();
  }

  async hideInactiveHistory() {
    if (this.showHistory) await this.loadHistory();
    const visible = groupedSessions(this.manager.entries, this.history, this.showHistory, this.displayOptions());
    const unique = new Map(visible.flatMap(group => [...group.sessions, ...(group.children || []).flatMap(child => child.sessions)]).map(entry => [sessionKey(entry), entry]));
    const before = this.manager.hiddenHistory.size;
    await this.manager.hideHistoryEntries([...unique.values()]);
    this.refresh();
    return this.manager.hiddenHistory.size - before;
  }

  async setCustomHistoryRange() {
    const raw = await this.vscode.window.showInputBox({ title: 'History Range', prompt: 'Show history from the last 1 to 36500 days.', value: String(this.historyRangeDays === 'all' ? 30 : this.historyRangeDays), validateInput: value => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 36500 ? undefined : 'Enter a whole number from 1 to 36500.' });
    if (raw) await this.setHistoryRange(Number(raw));
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
    const editor = this.vscode.window.activeTextEditor?.document?.uri;
    const folders = this.vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') || [];
    // Switching a terminal must not promote its folder and move the clicked row.
    const editorFolder = editor?.scheme === 'file' ? this.vscode.workspace.getWorkspaceFolder?.(editor)?.uri.fsPath : undefined;
    if (editorFolder) this.currentFolder = editorFolder;
    const currentFolder = this.currentFolder || folders[0]?.uri.fsPath;
    return {
      search: this.search,
      groupBy: this.groupBy,
      workspaceOnly: this.workspaceOnly,
      hiddenHistory: this.manager.hiddenHistory,
      historyRangeDays: this.historyRangeDays,
      workspaceFolders: folders.map(folder => folder.uri.fsPath),
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
    const pendingRows = [...(this.manager.pending?.values() || [])].map(entry => ({ ...entry, pendingStart: true }));
    const groups = groupedSessions([...this.manager.entries, ...pendingRows, ...(this.manager.liveOnlyEntries?.values() || [])], this.history, this.showHistory, this.displayOptions());
    if (this.view) this.view.message = this.search ? `Search: ${this.search}${groups.length ? '' : ' — No matching sessions.'}` : groups.length ? undefined : 'No matching sessions. Use the … menu to show history or all folders.';
    return groups;
  }

  getTreeItem(node) {
    const v = this.vscode;
    if (node.kind === 'folder' || node.kind === 'agent') {
      const enabled = node.sessions.filter(entry => entry.enabled !== false && !entry.ephemeral && !entry.pendingStart).length;
      const liveOnly = node.sessions.filter(entry => entry.ephemeral).length;
      const starting = node.sessions.filter(entry => entry.pendingStart).length;
      const defaultExpanded = node.sessions.some(entry => !entry.historyOnly);
      const item = new v.TreeItem(node.kind === 'folder' ? path.basename(node.cwd) || node.cwd : AGENT_NAMES[node.provider] || node.provider, (this.expandedGroups?.get(node.groupId) ?? defaultExpanded) ? v.TreeItemCollapsibleState.Expanded : v.TreeItemCollapsibleState.Collapsed);
      item.id = `group:${node.groupId}`;
      item.description = `${enabled} enabled · ${liveOnly ? `${liveOnly} live · ` : ''}${starting ? `${starting} starting · ` : ''}${node.sessions.length} sessions`;
      item.tooltip = node.kind === 'folder' ? node.cwd : AGENT_NAMES[node.provider] || node.provider;
      item.iconPath = node.kind === 'folder' ? new v.ThemeIcon('folder') : agentIcon(v, node.provider);
      item.contextValue = node.kind === 'folder' ? 'sessionFolder' : 'sessionAgent';
      return item;
    }
    const running = this.manager.live.get(node.id);
    const enabled = node.enabled !== false;
    const item = new v.TreeItem(node.name, v.TreeItemCollapsibleState.None);
    item.id = `session:${rowKey(node)}`;
    if (node.pendingStart) {
      item.description = 'Starting…';
      item.tooltip = `${AGENT_NAMES[node.provider] || node.provider}\n${node.cwd}\nWaiting for the agent to save its conversation. Send it a first message; the row becomes exactly bound and restorable automatically.`;
      item.iconPath = new v.ThemeIcon('sync~spin');
      item.contextValue = 'pendingSession';
      item.command = { command: 'agentSessionRestore.open', title: 'Focus Terminal', arguments: [node] };
      return item;
    }
    const working = this.manager.working?.has(node.id) === true;
    const status = this.manager.status?.get(node.id);
    const statusText = node.ephemeral ? 'Unknown · Live Only' : working ? 'Working' : status?.state === 'unknown' ? 'Unknown' : status?.state === 'restore-failed' ? 'Restore Failed' : running && v.window.terminals.includes(running) ? 'Open' : '';
    item.description = node.ephemeral ? statusText : [node.favorite ? '★ Favorite' : '', node.historyOnly || node.archived ? 'History' : enabled ? '' : 'Auto Restore Off', statusText].filter(Boolean).join(' · ');
    item.tooltip = node.ephemeral
      ? `${AGENT_NAMES[node.provider] || node.provider}\n${node.cwd}\nThis Codex terminal is live, but no exact conversation ID is available. Open focuses the existing terminal only; it cannot be restored automatically.${status?.reason ? `\n${status.reason}` : ''}`
      : `${node.provider}\n${node.cwd}\nSession: ${node.sessionId}\n${enabled ? 'Auto restore enabled' : 'Auto restore disabled'}${status?.reason ? `\n${status.reason}` : ''}\nClick to open.`;
    item.iconPath = sessionIcon(v, node.provider, working, v.workspace?.getConfiguration('agentSessionRestore').get('sessionPulse', true) !== false && v.workspace?.getConfiguration('workbench').get('reduceMotion') !== 'on');
    item.contextValue = node.ephemeral ? 'liveSessionUnknown' : `${node.historyOnly ? 'historySession' : enabled ? 'enabledSession' : 'disabledSession'}${node.favorite ? 'Favorite' : ''}${status?.state === 'unknown' ? 'Unknown' : status?.state === 'restore-failed' ? 'Failed' : ''}`;
    item.command = { command: 'agentSessionRestore.open', title: 'Open Session', arguments: [node] };
    return item;
  }

  async ensureTracked(node) {
    if (node?.ephemeral) return undefined;
    return this.manager.entries.find(entry => entry.id === node.id)
      || this.manager.entries.find(entry => sessionKey(entry) === sessionKey(node))
      || this.manager.add(node, node.name, false);
  }

  dispose() { this.events.dispose(); }
}
module.exports = { SessionTree, groupedSessions, activityTime };
