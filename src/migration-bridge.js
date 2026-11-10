'use strict';

const { createMigrationSnapshot, workspaceFingerprint } = require('./migration');

function activate(context, vscodeApi = require('vscode')) {
  const fingerprint = workspaceFingerprint(vscodeApi.workspace);
  return Object.freeze({
    passive: true,
    getMigrationSnapshot: () => createMigrationSnapshot(context.workspaceState, fingerprint)
  });
}

module.exports = { activate };
