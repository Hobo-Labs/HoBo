export const title = 'Update a financial observation';
export const state = v => {
  if (v.phase === 'accepted') return 'Observation recorded';
  if (v.phase === 'rejected') return 'Observation refused';
  if (v.next < v.old) return 'An older observation arrives';
  if (v.changed && v.next === v.old) return 'A changed value has the same time';
  if (v.next > v.old) return 'A newer observation arrives';
  return 'An unchanged observation arrives';
};
export const step = action => ({Accept:'record the observation',Reject:'refuse the observation',Done:'finish'})[action] ?? action;
