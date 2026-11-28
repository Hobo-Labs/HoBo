export const title = 'Inspect a Yard generation result with current host approval';
export const state = v => {
  const phase = v.phase === 'ready' ? 'Provider result recorded' : 'Provider call pending';
  const approval = v.decision === 'allow' ? 'inspection approved' : 'inspection refused';
  const faults = [];
  if (v.read && !v.approvedAtRead) faults.push('result read without approval');
  if (v.recordedPlan !== 'original') faults.push('stored plan changed');
  return faults.length ? `${phase}: ${faults.join(', ')}` : v.read ? `${phase}; approved result read` : `${phase}; ${approval}`;
};
export const step = (action, from, to) => ({
  Revoke:'host revokes approval', Restore:'host restores approval',
  ProviderEdit:'provider changes its input copy', Finish:'provider result is recorded',
  Inspect:to.read ? 'read the approved result' : 'refuse the read', Done:'finish',
})[action] ?? null;
