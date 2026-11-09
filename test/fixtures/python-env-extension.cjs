'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { shellQuote } = require('../../src/core');
exports.activate = () => ({
  async getEnvironment() {
    return process.env.AGENT_RESTORE_TEST_PHASE === 'environment-restore' ? { envId: { id: 'fixture', managerId: 'test' } } : undefined;
  },
  async createTerminal(_environment, options) {
    const terminal = vscode.window.createTerminal(options);
    if (!terminal.shellIntegration) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listener.dispose(); reject(new Error('Shell integration did not initialize')); }, 10000);
      const listener = vscode.window.onDidChangeTerminalShellIntegration(event => {
        if (event.terminal === terminal && terminal.shellIntegration) { clearTimeout(timer); listener.dispose(); resolve(); }
      });
    });
    await new Promise((resolve, reject) => {
      let execution;
      const timer = setTimeout(() => { listener.dispose(); reject(new Error('Activation did not finish')); }, 10000);
      const listener = vscode.window.onDidEndTerminalShellExecution(event => {
        if (event.execution === execution) { clearTimeout(timer); listener.dispose(); resolve(); }
      });
      const file = path.join(process.env.AGENT_RESTORE_TEST_DATA, '.venv/bin/activate');
      execution = terminal.shellIntegration.executeCommand(`source ${shellQuote(file)} && sleep 0.3`);
    });
    return terminal;
  }
});
