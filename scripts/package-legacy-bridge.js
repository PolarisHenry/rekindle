'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

async function main() {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rekindle-legacy-bridge-'));
  const output = path.join(root, 'rekindle-legacy-bridge.vsix');
  try {
    const manifest = {
      name: 'agent-session-restore', displayName: 'Rekindle Legacy Migration', version: '0.8.5', publisher: 'local-tools',
      description: 'One-time metadata migration bridge for Rekindle session storage.', license: 'MIT',
      engines: { vscode: '^1.95.0' }, main: './migration-bridge.js', activationEvents: [], contributes: {}
    };
    await fs.writeFile(path.join(temp, 'package.json'), JSON.stringify(manifest, null, 2));
    await fs.copyFile(path.join(root, 'LICENSE'), path.join(temp, 'LICENSE'));
    await fs.copyFile(path.join(root, 'src/migration-bridge.js'), path.join(temp, 'migration-bridge.js'));
    await fs.copyFile(path.join(root, 'src/migration.js'), path.join(temp, 'migration.js'));
    await fs.writeFile(path.join(temp, '.vscodeignore'), '.git/**\n*.vsix\n');
    await fs.writeFile(path.join(temp, 'README.md'), '# Rekindle Legacy Migration\n\nThis temporary extension identity exposes only a read-only, workspace-scoped metadata snapshot for migration to ArionLee Rekindle. It does not restore sessions, observe terminals, install hooks, or launch agents. Keep it installed until each workspace has been opened by the new Rekindle identity.\n');
    const vsce = path.join(root, 'node_modules/.bin/vsce');
    const result = spawnSync(vsce, ['package', '--no-dependencies', '--allow-missing-repository', '--out', output], { cwd: temp, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`vsce exited with status ${result.status}`);
    console.log(`Created ${output}`);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
