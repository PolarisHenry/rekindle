'use strict';
const path = require('node:path');

function agentIcon(vscode, provider) {
  const file = name => vscode.Uri.file(path.join(__dirname, '..', 'media', 'agents', name));
  if (provider === 'codex') return { light: file('codex-light.svg'), dark: file('codex-dark.svg') };
  if (['pi', 'claude', 'agy'].includes(provider)) return file(`${provider}.svg`);
  return new vscode.ThemeIcon('terminal');
}

const SESSION_COLORS = {
  codex: 'terminal.ansiBlue',
  pi: 'terminal.ansiGreen',
  claude: 'terminal.ansiMagenta',
  agy: 'terminal.ansiYellow'
};

function sessionIcon(vscode, provider) {
  const color = SESSION_COLORS[provider] || 'terminal.ansiBrightWhite';
  return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(color));
}

module.exports = { agentIcon, sessionIcon, SESSION_COLORS };
