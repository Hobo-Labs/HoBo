export const title = 'Keep an active entitlement claim settleable';
export const state = (v) => {
  if (v.phase === 'new') return 'No reservation';
  if (v.phase === 'settled') return 'Usage settled';
  if (v.phase === 'released') return 'Unused reservation released';
  if (v.attempted) return v.claimed ? 'Scope change refused; claimed hold retained' : 'Scope change refused; hold retained';
  if (v.claimed) return 'Execution claimed; hold retained';
  return v.phase === 'uncertain' ? 'Outcome uncertain; hold retained' : 'Hold reserved';
};
export const step = (action) => ({
  Reserve: 'reserve entitlement claim',
  Claim: 'claim execution',
  Uncertain: 'execution outcome uncertain',
  ChangeScope: 'refuse scope change while active',
  ReplayMismatch: 'reject incompatible replay',
  Settle: 'settle final usage',
  Release: 'release unused reservation [before execution is claimed]',
  ChangeTerminalScope: 'change scope after finalization',
  Done: 'wait',
})[action] ?? action;
