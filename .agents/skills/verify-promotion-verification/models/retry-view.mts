export const title = 'Recover an uncertain rollback';
export const state = (v) => {
  if (!v.claimed) return 'Rollback not claimed';
  if (v.recorded) return 'Rollback result recorded';
  if (v.effects > 0) return 'Effect occurred; result uncertain';
  if (v.current !== v.base) return 'Set changed; reconciliation required';
  return 'Rollback claimed';
};
export const step = (action) => ({ Claim: 'record original Set', Effect: 'apply rollback', Record: 'record result', OtherChange: 'another change advances Set', Done: 'wait' })[action] ?? action;
