'use strict';

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

module.exports = { PROVIDERS, resolveAddContext, chooseProvider, dispatchAddHere };
