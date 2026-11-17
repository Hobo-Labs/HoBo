export const title = 'Check hosting financial evidence';
export const state = v => {
  if (v.phase === 'accepted') return 'Evidence accepted';
  if (v.phase === 'rejected') return 'Evidence refused';
  if (!v.calendarValid) return 'Evidence has an invalid date';
  if (v.observed > v.now) return 'Evidence is from the future';
  if (v.expires <= v.now) return 'Evidence has expired';
  return 'Evidence is current';
};
export const step = action => ({Accept:'accept evidence',Reject:'refuse evidence',Done:'finish'})[action] ?? action;
