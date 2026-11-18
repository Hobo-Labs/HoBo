export const title = 'Authorize and fund Yard generation with recoverable quota';
export const state = v => {
  const label = ({received:'Yard generation requested','quota-unavailable':'Quota authority unavailable',authorizing:'Host policy is being checked','policy-denied':'Host policy denied the request',authorized:'Host policy approved the request','quota-denied':'Generation quota unavailable','reserve-uncertain':'Quota reservation needs reconciliation','quota-held':'Generation quota reserved','budget-held':'Hosting budget reserved','released':'Unused quota released','quota-uncertain':'Quota needs reconciliation','budget-uncertain':'Quota released; budget needs reconciliation','quota-claimed':'Quota execution fence claimed',called:'Provider called',ready:'Yard readiness verified',uncertain:'Outcome needs reconciliation'})[v.phase];
  const faults=[];
  if(v.phase==='reserve-uncertain' && !v.uncertain) faults.push('unknown reservation not reported');
  if(v.quotaHeld && !v.present) faults.push('missing authority');
  if(v.quotaHeld && !v.policyAllowed) faults.push('policy denied');
  if(v.quotaHeld && !v.quotaAllowed) faults.push('quota exhausted');
  if(v.quotaReady && !v.readyEvidence) faults.push('readiness unverified');
  if(v.providerCalled && !v.authorityCurrent) faults.push('authority changed before call');
  if(v.providerCalled && !v.quotaClaimed) faults.push('execution not claimed');
  if(v.quotaReleased && v.quotaClaimed) faults.push('claimed quota released');
  return faults.length ? `${label}: ${faults.join(', ')}` : label;
};
export const step = (action,from,to) => ({
 Start:to.phase==='quota-unavailable'?'refuse without quota authority':'check host policy',
 Authorize:to.phase==='policy-denied'?'refuse host policy':'approve host policy',
 ReserveQuota:to.phase==='quota-denied'?'refuse exhausted quota':'reserve generation quota',
 ReserveUnknownCommitted:'reconcile unknown quota reservation', ReserveUnknownEmpty:'reconcile unknown quota reservation',
 HoldBudget:'reserve hosting budget', ReleaseBeforeBudget:'release unused quota',
 ReleaseAfterBudget:'release unused quota; retain budget for reconciliation',
 ReleaseFailed:'reconcile unverified quota cancellation', ReleaseUnknown:'reconcile unverified quota cancellation', ClaimQuota:'claim the execution fence',
 ChangeAuthority:'quota authority changes', Call:'call the provider',
 Abort:'retain exposure for reconciliation', Finish:to.phase==='ready'?'verify Yard readiness':'retain exposure for reconciliation', Done:'finish',
})[action] ?? null;
