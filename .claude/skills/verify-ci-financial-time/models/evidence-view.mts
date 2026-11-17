export const title = 'Review a CI financial observation';
export const state = v => {
  if (v.phase === 'accepted') return 'Observation accepted';
  if (v.phase === 'refused') return 'Observation refused';
  if (!v.valid) return 'Timestamp is invalid';
  if (v.observed > v.now) return 'Observation is in the future';
  if (v.observed < v.previous) return 'Observation moves backwards';
  if (v.observed === v.previous && v.changed) return 'Facts changed at the same instant';
  return 'Observation is current';
};
export const step = action => ({Accept:'accept observation',Refuse:'refuse observation',Done:'finish'})[action] ?? action;
