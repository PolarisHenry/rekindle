'use strict';

const { createHash } = require('node:crypto');
const STORAGE_KEY = 'agentSessionRestore.sessions.v1';

const OLD_EXTENSION_ID = 'local-tools.agent-session-restore';
const NEW_EXTENSION_ID = 'ArionLee.agent-session-restore';
const BRIDGE_VERSION = '0.8.5';
const MIGRATION_MARKER = 'rekindle.legacyMigration.v1';
const MIGRATION_PENDING = 'rekindle.legacyMigration.pending.v1';
const TREE_KEYS = ['rekindle.showHistory', 'rekindle.groupBy', 'rekindle.workspaceOnly'];
const ENTRY_KEYS = [
  'id', 'provider', 'sessionId', 'sessionFile', 'cwd', 'name', 'customName',
  'enabled', 'archived', 'createdAt', 'automatic', 'unresolved'
];

function workspaceFingerprint(workspace) {
  const workspaceFile = workspace.workspaceFile?.toString();
  const folders = (workspace.workspaceFolders || []).map(folder => folder.uri.toString()).sort();
  const identity = workspaceFile ? `file:${workspaceFile}` : `folders:${JSON.stringify(folders)}`;
  return createHash('sha256').update(identity).digest('hex');
}

function sanitizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  if (typeof entry.id !== 'string' || typeof entry.provider !== 'string' || typeof entry.cwd !== 'string' || typeof entry.name !== 'string') return undefined;
  const clean = {};
  for (const key of ENTRY_KEYS) {
    const value = entry[key];
    if (value !== undefined && (value === null || ['string', 'boolean', 'number'].includes(typeof value))) clean[key] = value;
  }
  return clean;
}

function createMigrationSnapshot(workspaceState, fingerprint) {
  const entries = workspaceState.get(STORAGE_KEY, []);
  return {
    schema: 1,
    source: OLD_EXTENSION_ID,
    fingerprint,
    sessions: Array.isArray(entries) ? entries.map(sanitizeEntry).filter(Boolean) : [],
    preferences: Object.fromEntries(TREE_KEYS.map(key => [key, workspaceState.get(key)]).filter(([, value]) => value !== undefined))
  };
}

function validateSnapshot(snapshot, fingerprint) {
  if (!snapshot || snapshot.schema !== 1 || snapshot.source !== OLD_EXTENSION_ID || snapshot.fingerprint !== fingerprint || !Array.isArray(snapshot.sessions)) return undefined;
  const sessions = snapshot.sessions.map(sanitizeEntry).filter(Boolean);
  const preferences = {};
  if (snapshot.preferences && typeof snapshot.preferences === 'object') {
    if (typeof snapshot.preferences['rekindle.showHistory'] === 'boolean') preferences['rekindle.showHistory'] = snapshot.preferences['rekindle.showHistory'];
    if (['folder', 'agent'].includes(snapshot.preferences['rekindle.groupBy'])) preferences['rekindle.groupBy'] = snapshot.preferences['rekindle.groupBy'];
    if (typeof snapshot.preferences['rekindle.workspaceOnly'] === 'boolean') preferences['rekindle.workspaceOnly'] = snapshot.preferences['rekindle.workspaceOnly'];
  }
  return { sessions, preferences };
}

function compareVersions(a, b) {
  const parse = value => String(value).split('.').map(part => Number.parseInt(part, 10) || 0);
  const left = parse(a), right = parse(b);
  for (let index = 0; index < 3; index++) if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) - (right[index] || 0);
  return 0;
}

async function importLegacySnapshot({ context, vscode, log }) {
  const fingerprint = workspaceFingerprint(vscode.workspace);
  const marker = context.workspaceState.get(MIGRATION_MARKER);
  if (marker?.fingerprint === fingerprint) return { status: 'already-imported' };

  const pending = context.workspaceState.get(MIGRATION_PENDING);
  if (pending?.fingerprint === fingerprint && pending.snapshot) {
    const recovered = validateSnapshot(pending.snapshot, fingerprint);
    if (recovered) {
      await commitSnapshot(context.workspaceState, recovered, fingerprint, true);
      return { status: 'recovered-import' };
    }
    await context.workspaceState.update(MIGRATION_PENDING, undefined);
  }

  const legacy = vscode.extensions?.getExtension(OLD_EXTENSION_ID);
  if (!legacy) return { status: 'not-installed' };
  if (compareVersions(legacy.packageJSON?.version, BRIDGE_VERSION) < 0) {
    return { status: 'blocked-old-version', version: legacy.packageJSON?.version };
  }

  let api;
  try { api = await legacy.activate(); }
  catch (error) { log(`Legacy migration bridge activation failed: ${error.message}`); return { status: 'blocked-bridge-error' }; }
  if (api?.passive !== true || typeof api.getMigrationSnapshot !== 'function') return { status: 'blocked-incompatible-bridge' };

  const snapshot = api.getMigrationSnapshot();
  const validated = validateSnapshot(snapshot, fingerprint);
  if (!validated) return { status: 'blocked-workspace-mismatch', passiveVerified: true };
  const existing = context.workspaceState.get(STORAGE_KEY, []);
  if (Array.isArray(existing) && existing.length > 0) {
    await context.workspaceState.update(MIGRATION_MARKER, { fingerprint, source: OLD_EXTENSION_ID, status: 'skipped-existing-data' });
    return { status: 'skipped-existing-data' };
  }
  await context.workspaceState.update(MIGRATION_PENDING, {
    fingerprint,
    snapshot: {
      schema: 1, source: OLD_EXTENSION_ID, fingerprint,
      sessions: validated.sessions, preferences: validated.preferences
    }
  });
  await commitSnapshot(context.workspaceState, validated, fingerprint, false);
  return { status: 'imported', count: validated.sessions.length };
}

async function commitSnapshot(workspaceState, snapshot, fingerprint, recovering) {
  const current = workspaceState.get(STORAGE_KEY, []);
  const currentEntries = Array.isArray(current) ? current.map(sanitizeEntry).filter(Boolean) : [];
  let sessions;
  if (recovering) {
    const byId = new Map(currentEntries.map(entry => [entry.id, entry]));
    for (const entry of snapshot.sessions) if (!byId.has(entry.id)) byId.set(entry.id, entry);
    sessions = [...byId.values()];
  } else sessions = snapshot.sessions;
  await workspaceState.update(STORAGE_KEY, sessions);
  for (const [key, value] of Object.entries(snapshot.preferences)) {
    if (recovering && workspaceState.get(key) !== undefined) continue;
    await workspaceState.update(key, value);
  }
  await workspaceState.update(MIGRATION_MARKER, { fingerprint, source: OLD_EXTENSION_ID, status: 'imported' });
  await workspaceState.update(MIGRATION_PENDING, undefined);
}

module.exports = {
  OLD_EXTENSION_ID, NEW_EXTENSION_ID, BRIDGE_VERSION, STORAGE_KEY, MIGRATION_MARKER, MIGRATION_PENDING,
  workspaceFingerprint, sanitizeEntry, createMigrationSnapshot, validateSnapshot,
  compareVersions, importLegacySnapshot
};
