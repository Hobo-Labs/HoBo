export const title = 'Retry Yard generation safely in one process';
export const state = v => {
  const label = ({new:'Generation not started', running:'Provider call in progress', unknown:'Provider outcome uncertain', checking:'Checking the existing attempt', ready:'Generation result recorded'})[v.phase];
  const faults = [];
  if (v.inspectWhilePending) faults.push('premature inspection');
  if (v.conflictAccepted) faults.push('conflicting plan accepted');
  if (v.providerWork === 'changed') faults.push('provider work changed');
  return faults.length ? `${label}: ${faults.join(', ')}` : label;
};
export const step = (action, from, to) => ({
  Start:'start provider work',
  RetrySame:'reuse the pending operation',
  RetryConflict:to.conflictAccepted ? 'reuse a conflicting plan' : 'refuse a conflicting plan',
  EditInput:to.providerWork === 'changed' ? 'caller changes provider work' : 'caller edits its original request',
  Finish:'record the provider result',
  LoseReply:'provider reply is lost',
  Inspect:'inspect the existing attempt',
  FinishInspect:'record the inspected result',
  Done:'finish',
})[action] ?? null;
