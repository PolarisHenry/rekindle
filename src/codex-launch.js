'use strict';
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { shellQuote } = require('./core');
const capabilities = new Map();

async function dedicatedCodexConfig(config, run = promisify(execFile), cache = capabilities) {
  const args = config.codexArguments || [];
  if (config.codexDedicatedProcess !== true || process.platform === 'win32'
    || args.some(arg => arg === '--remote' || arg.startsWith('--remote=') || arg === '--no-daemon')) return config;
  const command = config.codexCommand || 'codex';
  if (!cache.has(command)) cache.set(command, run(process.env.SHELL || '/bin/zsh', ['-ilc', `${shellQuote(command)} --help`], { timeout: 5000, maxBuffer: 262144 })
    .then(result => /(?:^|\s)--no-daemon\b/.test(result.stdout), () => false));
  return await cache.get(command) ? { ...config, codexArguments: [...args, '--no-daemon'] } : config;
}

module.exports = { dedicatedCodexConfig };
