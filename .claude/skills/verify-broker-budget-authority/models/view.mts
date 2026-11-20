export const title = 'Protect a hosting budget through execution';
export const state = v => {
  const phase = v.phase[1];
  if (phase === 'held' || phase === 'uncertain') {
    if (v.evidence[1]) return 'Final usage and stop confirmed';
    if (phase === 'uncertain') return 'Outcome uncertain; budget held';
    return v.claimed[1] ? 'Execution claimed; budget held' : 'Budget reserved';
  }
  if (phase === 'settled' && v.usage[1] > 1) return 'Usage settled with provider overrun';
  return ({new:'Waiting for budget', released:'Unused budget released', settled:'Usage settled'})[phase];
};
export const step = action => ({Reserve:'reserve full liability',Claim:'claim execution',Uncertain:'execution outcome uncertain',ObserveFinal:'confirm final usage and stopped source',ObserveUnused:'confirm funds are unused',Release:'release confirmed unused budget [if execution was never claimed]',Settle:'settle actual usage',Done:'finish'})[action] ?? action;
