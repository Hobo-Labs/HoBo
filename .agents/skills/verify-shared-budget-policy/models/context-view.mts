export const state = v => ({
  checking: 'Budget evaluation requested',
  accepted: 'Valid context evaluated',
  refused: 'Malformed context refused',
  crashed: 'Malformed context crashed',
})[v.phase];

export const step = action => ({ Evaluate: 'validate context and measurements' })[action] ?? action;
