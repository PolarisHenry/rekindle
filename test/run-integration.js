'use strict';
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..');
  const data = path.join(root, '.test-data');
  if (!process.env.REKINDLE_TEST_PHASES) await fs.rm(data, { recursive: true, force: true });
  for (const dir of ['workspace', 'user/User', 'extensions']) await fs.mkdir(path.join(data, dir), { recursive: true });
  const driver = path.join(data, 'extensions/local-tools.restore-integration-driver-0.0.1');
  await fs.mkdir(driver, { recursive: true });
  await fs.writeFile(path.join(driver, 'package.json'), JSON.stringify({ name: 'restore-integration-driver', publisher: 'local-tools', version: '0.0.1', engines: { vscode: '^1.95.0' }, main: './index.js', activationEvents: ['onStartupFinished'] }));
  await fs.writeFile(path.join(driver, 'index.js'), `const vscode=require('vscode');const fs=require('node:fs/promises');const path=require('node:path');exports.activate=async()=>{let result;try{await require(${JSON.stringify(path.join(__dirname, 'integration-suite.js'))}).run();result={ok:true};}catch(error){result={ok:false,error:error.stack};}await fs.writeFile(path.join(process.env.AGENT_RESTORE_TEST_DATA,process.env.AGENT_RESTORE_TEST_PHASE+'.result.json'),JSON.stringify(result));await vscode.commands.executeCommand('workbench.action.quit');};\n`);
  const cli = path.join(data, "fake agent's cli");
  await fs.writeFile(cli, `#!${process.execPath}\nrequire(${JSON.stringify(path.join(__dirname, 'fixtures/fake-agent.cjs'))});\n`, { mode: 0o755 });
  await fs.writeFile(path.join(data, 'pi-session.jsonl'), JSON.stringify({ type: 'session', id: 'pi-exact-id', cwd: path.join(data, 'workspace') }) + '\n');
  await fs.writeFile(path.join(data, 'user/User/settings.json'), JSON.stringify({
    'agentSessionRestore.codexCommand': cli,
    'agentSessionRestore.piCommand': cli,
    'agentSessionRestore.claudeCommand': cli,
    'agentSessionRestore.agyCommand': cli,
    'agentSessionRestore.codexHome': path.join(data, 'codex'),
    'agentSessionRestore.piHome': path.join(data, 'pi'),
    'agentSessionRestore.claudeHome': path.join(data, 'claude'),
    'agentSessionRestore.agyHome': path.join(data, 'agy'),
    'security.workspace.trust.enabled': false,
    'terminal.integrated.enablePersistentSessions': true,
    'terminal.integrated.shellIntegration.enabled': true,
    'update.mode': 'none',
    'telemetry.telemetryLevel': 'off',
    'workbench.startupEditor': 'none'
  }));
  const phases = process.env.REKINDLE_TEST_PHASES?.split(',') || ['seed', 'restore', 'auto-seed', 'auto-restore', 'multi-seed', 'multi-restore', 'environment-restore', 'disabled-restore'];
  for (const phase of phases) {
    if (phase === 'environment-restore') {
      const python = path.join(data, 'extensions/ms-python.vscode-python-envs-1.42.0');
      await fs.mkdir(python, {recursive:true});
      await fs.writeFile(path.join(python,'package.json'),JSON.stringify({name:'vscode-python-envs',publisher:'ms-python',version:'1.42.0',engines:{vscode:'^1.110.0'},main:'./index.cjs',activationEvents:['onStartupFinished']}));
      await fs.writeFile(path.join(python,'index.cjs'),`module.exports=require(${JSON.stringify(path.join(__dirname,'fixtures/python-env-extension.cjs'))});`);
      await fs.mkdir(path.join(data,'.venv/bin'),{recursive:true});
      await fs.writeFile(path.join(data,'.venv/bin/activate'),'export REKINDLE_TEST_ENV=active\n');
    }
    // --extensionTestsPath deliberately uses in-memory storage; a separate driver
    // extension exercises a normal application lifecycle and real workspace DB.
    await new Promise((resolve, reject) => {
      const env = { ...process.env, AGENT_RESTORE_TEST_PHASE: phase, AGENT_RESTORE_TEST_DATA: data };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(process.env.VSCODE_EXECUTABLE_PATH || '/Applications/Visual Studio Code.app/Contents/MacOS/Code', [
        path.join(data, 'workspace'), `--extensionDevelopmentPath=${root}`,
        ...(['environment-restore','disabled-restore'].includes(phase) ? [`--extensionDevelopmentPath=${path.join(data,'extensions/ms-python.vscode-python-envs-1.42.0')}`] : []), '--user-data-dir', path.join(data, 'user'), '--extensions-dir', path.join(data, 'extensions'),
        '--disable-updates', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-telemetry'
      ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const log = createWriteStream(path.join(data, `${phase}.log`));
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${phase} timed out; see .test-data/${phase}.log`)); }, 60000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('close', code => { clearTimeout(timeout); log.end(); code === 0 ? resolve() : reject(new Error(`${phase} exited ${code}; see log`)); });
    });
    const result = JSON.parse(await fs.readFile(path.join(data, `${phase}.result.json`), 'utf8'));
    if (!result.ok) throw new Error(result.error);
    console.log(`PASS ${phase}: exact IDs, terminal names, cwd, deduplication and persistent state.`);
  }
  console.log('Integration passed: two exact conversation IDs restored after a full VS Code exit/restart.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
