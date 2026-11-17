export const title = 'Check hosting entitlement evidence';
export const state = v => {
  if (v.phase === 'accepted') return 'Entitlement evidence accepted';
  if (v.phase === 'rejected') return 'Entitlement evidence refused';
  return v.observed > v.clock * 2 ? 'Entitlement observation is in the future' : 'Entitlement observation is current';
};
export const step = action => ({Accept:'accept evidence',Reject:'refuse evidence',Done:'finish'})[action] ?? action;
