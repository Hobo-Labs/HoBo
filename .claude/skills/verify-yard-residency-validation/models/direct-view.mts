export const title = 'Check residency for direct generation calls';
export const state = v => ({
  plan: 'Generation layout received',
  run: v.viaPlanner ? 'Valid plan prepared' : 'Supplied plan received',
  refused: 'Invalid residency refused',
  done: 'Yard provider invoked',
})[v.phase];
export const step = (action, from, to) => ({
  Plan: to.phase === 'refused' ? 'refuse an invalid layout' : 'prepare a valid plan',
  Run: to.phase === 'refused' ? 'refuse an invalid plan' : 'invoke the Yard provider',
  Done: 'finish',
})[action] ?? null;
