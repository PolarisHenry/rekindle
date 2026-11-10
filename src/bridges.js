'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { shellQuote } = require('./core');

async function updateJson(file, mutate) {
  let original = '';
  try { original = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const data = original ? JSON.parse(original) : {};
  mutate(data);
  const next = JSON.stringify(data, null, 2) + '\n';
  if (next === original) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (original) await fs.writeFile(`${file}.rekindle-backup-${Date.now()}`, original, { mode: 0o600 });
  const temp = `${file}.rekindle-${process.pid}.tmp`;
  await fs.writeFile(temp, next, { mode: 0o600 });
  await fs.rename(temp, file);
}

async function installAgentBridges(home = os.homedir()) {
  const target = path.join(home, '.local/share/rekindle/session-hook.cjs');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(__dirname, 'session-hook.cjs'), target);
  const command = (provider, event) => `node ${shellQuote(target)} ${provider}${event ? ` ${event}` : ''}`;
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  await updateJson(path.join(claudeHome, 'settings.json'), data => {
    data.hooks ||= {};
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      data.hooks[event] ||= [];
      data.hooks[event] = data.hooks[event].filter(group => !group.hooks?.some(hook => hook.rekindle === true || hook.command?.includes('/rekindle/session-hook.cjs')));
      data.hooks[event].push({ hooks: [{ type: 'command', command: command('claude'), timeout: 5 }] });
    }
  });
  await updateJson(path.join(home, '.gemini/config/hooks.json'), data => {
    const existing = data.rekindle || {};
    data.rekindle = { ...existing,
      SessionStart: [{ type: 'command', command: command('agy', 'SessionStart'), timeout: 5 }],
      PreInvocation: [{ type: 'command', command: command('agy', 'PreInvocation'), timeout: 5 }],
      Stop: [{ type: 'command', command: command('agy', 'Stop'), timeout: 5 }]
    };
  });
}
module.exports = { installAgentBridges, updateJson };
