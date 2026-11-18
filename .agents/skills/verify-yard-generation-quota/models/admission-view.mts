export const title = 'Authorize and reserve capacity before Yard generation';
export const state = v => {
  if (v.phase === 'budget-held' && !v.authorityCurrent) return 'Quota authority changed before provider';
  const label = ({
    received:'Yard generation requested',
    'quota-unavailable':'Quota authority unavailable',
    authorizing:'Host policy is being checked',
    'policy-denied':'Host policy denied the request',
    authorized:'Host policy approved the request',
    'quota-denied':'Generation quota unavailable',
    'quota-held':'Generation quota reserved',
    'budget-held':'Hosting budget reserved',
    called:'Provider called',
    ready:'Yard readiness verified',
    uncertain:'Outcome needs reconciliation',
  })[v.phase];
  const faults = [];
  if (v.quotaHeld && !v.present) faults.push('missing authority');
  if (v.quotaHeld && !v.policyAllowed) faults.push('policy denied');
  if (v.quotaHeld && !v.quotaAllowed) faults.push('quota exhausted');
  if (v.quotaReady && !v.readyEvidence) faults.push('readiness unverified');
  if (v.providerCalled && !v.authorityCurrent) faults.push('authority changed before call');
  return faults.length ? `${label}: ${faults.join(', ')}` : label;
};
export const step = (action, from, to) => ({
  Start:to.phase === 'quota-unavailable' ? 'refuse without quota authority' : 'check host policy',
  Authorize:to.phase === 'policy-denied' ? 'refuse host policy' : 'approve host policy',
  ReserveQuota:to.phase === 'quota-denied' ? 'refuse exhausted quota' : 'reserve generation quota',
  HoldBudget:'reserve hosting budget',
  ChangeAuthority:'quota authority changes',
  Call:'call the provider',
  Abort:'retain exposure for reconciliation',
  Finish:to.phase === 'ready' ? 'verify Yard readiness' : 'retain exposure for reconciliation',
  Done:'finish',
})[action] ?? null;
