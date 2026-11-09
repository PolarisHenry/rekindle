'use strict';
// A deliberately quiet, local-only observer. Never returns hook decisions,
// changes approval policy, or forwards prompts/transcript contents.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function normalize(provider, payload) {
  if (payload.agent_id || payload.parentConversationId || payload.parent_conversation_id) return null;
  const sessionId = provider === 'agy' ? payload.rootConversationId || payload.conversationId : payload.session_id;
  const cwd = provider === 'agy' ? payload.workspacePaths?.[0] : payload.cwd;
  if (!['claude', 'agy'].includes(provider) || typeof sessionId !== 'string' || !sessionId || !path.isAbsolute(cwd || '')) return null;
  return { provider, sessionId, cwd, sessionFile: payload.transcript_path || payload.transcriptPath };
}

function owningProcess(parent, text, provider) {
  const processes = new Map(text.split('\n').flatMap(line => {
    const row = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return row ? [[Number(row[1]), { pid: Number(row[1]), parent: Number(row[2]), command: row[3] }]] : [];
  }));
  const seen = new Set();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const row = processes.get(parent);
    if (!row) break;
    if (path.basename(row.command) === provider) return row.pid;
    parent = row.parent;
  }
  return null;
}

function main() {
  try {
    if (process.env.TERM_PROGRAM !== 'vscode') return;
    const provider = process.argv[2];
    const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    const session = normalize(provider, payload);
    if (!session) return;
    const pid = owningProcess(process.ppid, execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 3000 }), provider);
    if (!pid) return;
    const registry = path.join(os.homedir(), '.local/state/vscode-agent-session-restore/pi');
    fs.mkdirSync(registry, { recursive: true, mode: 0o700 });
    const target = path.join(registry, `${pid}.json`);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ ...session, pid, updatedAt: Date.now() }), { mode: 0o600 });
    fs.renameSync(temp, target);
  } catch { /* An observer must never interrupt the agent. */ }
}
if (require.main === module) main();
module.exports = { normalize, owningProcess };
