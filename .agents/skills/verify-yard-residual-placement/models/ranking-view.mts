export const title = 'Compare residual resource prices';
export const state = v => {
  if (v.phase === 'selected') return 'Lowest comparable price selected';
  if (v.phase === 'refused') return 'Catalog prices refused';
  return 'Eligible Yard prices awaiting comparison';
};
export const step = (a, from, to) => a === 'Select' ? 'compare exact prices' : a === 'Refuse' ? 'refuse invalid evidence' : 'finish';
