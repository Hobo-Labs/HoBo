export const title = 'Compare complete quotes for eligible plans';
export const state = v => {
  if (v.phase === 'selected') return 'Affordable plan selected';
  if (v.phase === 'rejected') return 'Request refused';
  if (v.phase === 'ranked') return 'Trusted complete quotes ready';
  return 'Plans awaiting complete quotes';
};
export const step = (a, from, to) => {
  if (a === 'Scan') return to.phase === 'ranked' ? 'check all quotes and bounds' : 'refuse incomplete search';
  if (a === 'Rank') return to.phase === 'selected' ? 'select lowest quoted total' : 'no candidate fits the cap';
  return a === 'Done' ? 'finish' : a;
};
