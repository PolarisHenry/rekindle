'use strict';

// Shared order for the Add Session picker and terminal restoration.
const PROVIDERS = [
  { label: 'pi', value: 'pi' },
  { label: 'Codex', value: 'codex' },
  { label: 'Claude Code', value: 'claude' },
  { label: 'Antigravity', value: 'agy' }
];

function compareProviders(a, b) {
  const rank = provider => {
    const index = PROVIDERS.findIndex(item => item.value === provider);
    return index < 0 ? PROVIDERS.length : index;
  };
  return rank(a.provider) - rank(b.provider);
}

module.exports = { PROVIDERS, compareProviders };
