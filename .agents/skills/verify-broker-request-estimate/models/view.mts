export const title = 'Supply an estimate before a broker budget check';
export const state = v => {
  if (v.phase === 'admitted') return 'Continue to the budget check';
  if (v.phase === 'rejected') return 'Request refused';
  if (v.origin === 'local') return 'Use the zero-cost local catalog';
  if (v.origin === 'registry') return 'Registry request has no estimate';
  if (v.input === 'missing') return 'Request has no estimate';
  if (v.input === 'invalid' || v.input === 'conflict') return 'Request has an invalid estimate';
  return 'Request has an explicit estimate';
};
export const step = action => ({Admit:'accept the estimate',Reject:'refuse the request',Done:'finish'})[action] ?? action;
