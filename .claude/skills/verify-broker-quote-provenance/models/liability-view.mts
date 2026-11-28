export const title = 'Check an attested liability';
export const state = v => {
  if (v.phase === 'approved') return 'Liability authorized';
  if (v.phase === 'refused') return 'Liability refused';
  if (v.bound < v.quoted) return 'Liability does not cover the quote';
  if (v.bound > v.originalCap) return 'Liability exceeds the budget';
  return 'Liability fits the budget';
};
export const step = action => ({Approve:'authorize liability',Refuse:'refuse liability',Done:'finish'})[action] ?? action;
