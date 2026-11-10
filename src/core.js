'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { fileURLToPath, pathToFileURL } = require('node:url');

function expandHome(value) {
  return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function sessionKey(session) {
  return `${session.provider}:${session.sessionId}`;
}

function shellQuote(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error('Invalid characters in a command argument');
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function startupArguments(provider, config = {}) {
  if (!['codex', 'pi', 'claude', 'agy'].includes(provider)) throw new Error('Invalid agent provider');
  const extra = config[`${provider}Arguments`] ?? [];
  if (!Array.isArray(extra) || extra.some(value => typeof value !== 'string' || /[\0\r\n]/.test(value))) {
    throw new Error(`${provider}Arguments must be an array of single-line strings`);
  }
  return extra;
}

function newSessionCommand(provider, config = {}) {
  return [config[`${provider}Command`] || provider, ...startupArguments(provider, config)].map(shellQuote).join(' ');
}

function resumeArguments(session, config = {}) {
  if (typeof session.sessionId !== 'string' || !session.sessionId.trim()) throw new Error('Invalid agent session');
  const extra = startupArguments(session.provider, config);
  if (session.provider === 'codex') return [...extra, 'resume', session.sessionId];
  if (session.provider === 'claude') return [...extra, '--resume', session.sessionId];
  if (session.provider === 'agy') return [...extra, '--conversation', session.sessionId];
  return [...extra, '--session', session.sessionFile || session.sessionId];
}

function launchOptions(session, config = {}, platform = process.platform) {
  const executable = config[`${session.provider}Command`] || session.provider;
  const args = resumeArguments(session, config);
  const env = { AGENT_SESSION_RESTORE_ID: session.id };
  if (session.provider === 'codex' && config.codexHome) env.CODEX_HOME = expandHome(config.codexHome);
  if (session.provider === 'pi' && config.piHome) env.PI_CODING_AGENT_DIR = expandHome(config.piHome);
  const common = {
    name: session.name,
    cwd: session.cwd,
    env,
    isTransient: true
  };
  if (platform === 'win32') return { ...common, shellPath: executable, shellArgs: args };
  // Use the user's normal terminal profile so VS Code can inject shell integration.
  return common;
}

function resumeCommand(session, config = {}) {
  return [config[`${session.provider}Command`] || session.provider, ...resumeArguments(session, config)].map(shellQuote).join(' ');
}

function cleanTitle(text) {
  return String(text || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function isInWorkspace(cwd, folders) {
  return folders.some(folder => {
    const relative = path.relative(folder, cwd);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  });
}

function resolveTargetFolder(target) {
  if (typeof target === 'string') return target;
  return target?.cwd || target?.fsPath || target?.uri?.fsPath;
}

async function dispatchFolderAdd(target, executeCommand) {
  const folder = resolveTargetFolder(target);
  if (folder) return executeCommand('agentSessionRestore.add', folder);
}

async function jsonlFiles(root, depth = 5) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const lists = await Promise.all(entries.map(async item => {
    const full = path.join(root, item.name);
    if (item.isDirectory() && depth > 0) return jsonlFiles(full, depth - 1);
    if (item.isFile() && item.name.endsWith('.jsonl')) {
      const stat = await fs.stat(full).catch(() => null);
      return stat ? [{ file: full, updatedAt: stat.mtimeMs }] : [];
    }
    return [];
  }));
  return lists.flat();
}

async function readEdges(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, 65536);
    const head = Buffer.alloc(length);
    await handle.read(head, 0, length, 0);
    const tail = Buffer.alloc(length);
    await handle.read(tail, 0, length, Math.max(0, stat.size - length));
    const parse = text => text.split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    return { head: parse(head.toString()), tail: parse(tail.toString()) };
  } finally { await handle.close(); }
}

async function discoverFiles(provider, root) {
  const files = (await jsonlFiles(root)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 1500);
  const sessions = [];
  // Batches bound the number of open handles even with years of conversation history.
  for (let i = 0; i < files.length; i += 24) {
    const batch = await Promise.all(files.slice(i, i + 24).map(async ({ file, updatedAt }) => {
      try {
        const { head, tail } = await readEdges(file);
        const header = provider === 'codex' ? head.find(item => item.type === 'session_meta')?.payload : head.find(item => item.type === 'session');
        if (!header?.id || !path.isAbsolute(header.cwd || '')) return null;
        const info = [...head, ...tail].filter(item => item.type === 'session_info' && item.name).at(-1);
        const firstUserMessage = head.find(item => item.type === 'message' && item.message?.role === 'user')?.message?.content;
        const firstText = typeof firstUserMessage === 'string' ? firstUserMessage : firstUserMessage?.filter(item => item.type === 'text').map(item => item.text).join(' ');
        const title = cleanTitle(info?.name || header.name || header.title || firstText || header.id);
        return { provider, sessionId: header.id, sessionFile: file, cwd: header.cwd, title, updatedAt };
      } catch { return null; } // Files may be changing while a CLI is writing them.
    }));
    sessions.push(...batch.filter(Boolean));
  }
  return sessions;
}

async function discoverCodex(root, warn) {
  let rows = [];
  // Newer Codex builds can store paginated history in SQLite rather than rollout files.
  let databases = [];
  try { databases = (await fs.readdir(root)).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0])); }
  catch (error) { if (error.code !== 'ENOENT') warn(error.message); }
  for (const database of databases.slice(0, 1)) {
    try {
      const { stdout } = await execFile('sqlite3', ['-readonly', '-json', path.join(root, database), 'SELECT id, cwd, title, rollout_path, updated_at FROM threads WHERE archived = 0 AND has_user_event = 1 ORDER BY updated_at DESC LIMIT 1500;'], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
      rows = JSON.parse(stdout || '[]').filter(row => path.isAbsolute(row.cwd || '')).map(row => ({
        provider: 'codex', sessionId: row.id, cwd: row.cwd, title: cleanTitle(row.title || row.id),
        sessionFile: row.rollout_path, updatedAt: row.updated_at * 1000
      }));
    } catch (error) { warn(`Codex index unavailable; falling back to local session files: ${error.message}`); }
  }
  const index = new Map();
  try {
    const { head, tail } = await readEdges(path.join(root, 'session_index.jsonl'));
    for (const row of [...head, ...tail]) if (row.id && row.thread_name) index.set(row.id, cleanTitle(row.thread_name));
  } catch { /* Optional index. */ }
  const files = await discoverFiles('codex', path.join(root, 'sessions'));
  const merged = new Map(files.map(row => [row.sessionId, { ...row, title: index.get(row.sessionId) || row.title }]));
  for (const row of rows) merged.set(row.sessionId, row);
  return [...merged.values()];
}

async function discoverSessions(provider, config = {}, warn = () => {}) {
  if (provider === 'codex') return discoverCodex(expandHome(config.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')), warn);
  if (provider === 'pi') {
    const root = config.piHome ? path.join(expandHome(config.piHome), 'sessions') : process.env.PI_CODING_AGENT_SESSION_DIR || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), 'sessions');
    return discoverFiles('pi', root);
  }
  if (provider === 'claude') {
    const root = config.claudeHome || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const files = (await jsonlFiles(path.join(root, 'projects'))).filter(item => !item.file.includes(`${path.sep}subagents${path.sep}`)).sort((a,b) => b.updatedAt-a.updatedAt).slice(0, 1500);
    const sessions = [];
    for (let i = 0; i < files.length; i += 24) {
      const batch = await Promise.all(files.slice(i, i+24).map(async ({ file, updatedAt }) => {
        try {
          const { head, tail } = await readEdges(file);
          const header = head.find(row => row.sessionId && path.isAbsolute(row.cwd || '') && !row.isSidechain);
          if (!header) return null;
          const custom = [...head,...tail].filter(row => row.type === 'custom-title').at(-1)?.customTitle;
          const content = head.find(row => row.type === 'user' && row.message?.content)?.message.content;
          const text = typeof content === 'string' ? content : content?.filter(item => item.type === 'text').map(item => item.text).join(' ');
          return { provider, sessionId: header.sessionId, sessionFile: file, cwd: header.cwd, title: cleanTitle(custom || text || header.sessionId), updatedAt };
        } catch { return null; }
      }));
      sessions.push(...batch.filter(Boolean));
    }
    return sessions;
  }
  if (provider === 'agy') {
    const root = config.agyHome || path.join(os.homedir(), '.gemini/antigravity-cli');
    const db = path.join(root, 'conversation_summaries.db');
    const query = "SELECT conversation_id, title, workspace_uris, last_modified_time FROM conversation_summaries WHERE parent_conversation_id = '' ORDER BY last_modified_time DESC LIMIT 1500;";
    let stdout;
    try { ({ stdout } = await execFile('sqlite3', ['-readonly','-json',db,query], { timeout: 10000, maxBuffer: 4*1024*1024 })); }
    catch {
      try { ({ stdout } = await execFile('sqlite3', ['-json',pathToFileURL(db).href+'?mode=ro&immutable=1',query], { timeout: 10000, maxBuffer: 4*1024*1024 })); }
      catch (error) { warn(`AGY history unavailable: ${error.message}`); return []; }
    }
    return JSON.parse(stdout || '[]').flatMap(row => {
      try {
        const workspace = JSON.parse(row.workspace_uris)?.[0];
        const cwd = workspace?.startsWith('file:') ? fileURLToPath(workspace) : workspace;
        if (!path.isAbsolute(cwd || '')) return [];
        return [{ provider, sessionId: row.conversation_id, cwd, title: cleanTitle(row.title || row.conversation_id), updatedAt: Date.parse(row.last_modified_time) || 0 }];
      } catch { return []; }
    });
  }
  throw new Error('Unsupported agent provider');
}

module.exports = { startupArguments, newSessionCommand, expandHome, sessionKey, shellQuote, resumeArguments, resumeCommand, launchOptions, cleanTitle, isInWorkspace, resolveTargetFolder, dispatchFolderAdd, discoverSessions };
