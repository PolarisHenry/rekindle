'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const PROVIDERS = [
  { label: 'Codex', value: 'codex' }, { label: 'pi', value: 'pi' },
  { label: 'Claude Code', value: 'claude' }, { label: 'Antigravity CLI', value: 'agy' }
];

function resolveAddContext(target) {
  if (typeof target === 'string') return { cwd: target };
  if (!target || typeof target !== 'object') return {};
  const cwd = target.cwd || target.uri?.fsPath || target.fsPath;
  const provider = PROVIDERS.some(item => item.value === target.provider) ? target.provider : undefined;
  return { ...(cwd ? { cwd } : {}), ...(provider ? { provider } : {}) };
}

async function chooseProvider(vscode, preferred) {
  const context = resolveAddContext(preferred);
  const selected = PROVIDERS.find(item => item.value === context.provider);
  return selected || vscode.window.showQuickPick(PROVIDERS, {
    title: 'Rekindle: Add Session', placeHolder: 'Choose an agent'
  });
}

async function dispatchAddHere(target, executeCommand) {
  return executeCommand('agentSessionRestore.add', target);
}

async function resolveWorkingDirectory(options) {
  const { cwd, folders, suggested, chooseDirectory, stat = fs.stat } = options;
  if (typeof cwd === 'string' && cwd.length > 0) {
    let directory;
    if (path.isAbsolute(cwd)) directory = await stat(cwd).catch(() => undefined);
    if (!directory?.isDirectory()) throw new Error(`The selected folder is unavailable: ${cwd}. Choose a valid folder and try again.`);
    return cwd;
  }
  return chooseDirectory(folders, suggested);
}

module.exports = { PROVIDERS, resolveAddContext, chooseProvider, dispatchAddHere, resolveWorkingDirectory };
