export const title = 'Authorize Yard generation before a provider call';
export const state = v => {
  const label = ({new:'Generation requested', scheduled:'Authorized; provider call pending', denied:'Generation refused', ready:'Provider called'})[v.phase];
  const faults = [];
  if (v.phase === 'scheduled' && !v.initialApproved) faults.push('without initial approval');
  if (v.called && !v.approvedAtCall) faults.push('without current approval');
  if (v.cachedServed && !v.approvedAtCache) faults.push('cached result returned without approval');
  if (v.providerWork === 'changed') faults.push('provider work changed');
  return faults.length ? `${label}: ${faults.join(', ')}` : label;
};
export const step = (action, from, to) => ({
  Review: to.phase === 'scheduled' ? 'host approves the plan' : 'host refuses the plan',
  Revoke: 'approval is revoked',
  AlterDecision: 'host changes the plan in its decision',
  ReplaceCallback: 'host replaces the decision during the request',
  Dispatch: to.called ? 'call the provider with current approval' : 'refuse the provider call',
  RetryCached: to.cachedServed ? 'return the approved result' : 'refuse a cached result',
  EditRetained: 'host edits its retained decision copy',
  Done: 'finish',
})[action] ?? null;
