'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dedicatedCodexConfig } = require('../src/codex-launch');

test('dedicated Codex launches preserve user flags and capability probing is cached', async () => {
  const cache = new Map(); let calls = 0;
  const run = async () => { calls++; return { stdout: '  --no-daemon  Run without shared server' }; };
  const config = { codexDedicatedProcess: true, codexArguments: ['--yolo'] };
  for (let i = 0; i < 2; i++) assert.deepEqual((await dedicatedCodexConfig(config, run, cache)).codexArguments, ['--yolo', '--no-daemon']);
  assert.equal(calls, 1);
  assert.deepEqual(config.codexArguments, ['--yolo']);
});

test('older Codex, unavailable executables, remote connections and opt-outs retain original arguments', async () => {
  const base = { codexDedicatedProcess: true, codexArguments: ['--yolo'] };
  assert.equal(await dedicatedCodexConfig(base, async () => ({ stdout: '--help' }), new Map()), base);
  assert.equal(await dedicatedCodexConfig(base, async () => { throw new Error('missing'); }, new Map()), base);
  const never = async () => { throw new Error('should not probe'); };
  for (const config of [{ ...base, codexDedicatedProcess: false }, { ...base, codexArguments: ['--remote', 'unix:///tmp/server'] }, { ...base, codexArguments: ['--no-daemon'] }]) {
    assert.equal(await dedicatedCodexConfig(config, never, new Map()), config);
  }
});
