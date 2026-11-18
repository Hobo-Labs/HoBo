export const title = 'Reject invalid residency before Yard generation';
export const state = v => ({
  parse: 'Residency request received',
  refused: 'Invalid residency refused',
  reserve: 'Residency accepted for generation',
  provision: 'Generation funding held',
  done: 'Yard generation invoked',
})[v.phase];
export const step = (action, from, to) => ({
  Parse: to.phase === 'refused' ? 'refuse an invalid tag' : 'accept a valid tag',
  Reserve: 'reserve generation funding',
  Provision: 'invoke the Yard provider',
  Done: 'finish',
})[action] ?? null;
