'use strict';
const path = require('node:path');

function agentIcon(vscode, provider) {
  const file = name => vscode.Uri.file(path.join(__dirname, '..', 'media', 'agents', name));
  if (provider === 'codex') return { light: file('codex-light.png'), dark: file('codex-dark.png') };
  if (['pi', 'claude', 'agy'].includes(provider)) return file(`${provider}.svg`);
  return new vscode.ThemeIcon('terminal');
}

module.exports = { agentIcon };
