export const title = 'Order eligible catalog prices';
export const state = v => {
  if (v.phase === 'selected') return 'Lowest comparable catalog price selected';
  if (v.phase === 'refused') return 'Catalog evidence refused';
  if (!v.validA || !v.validB) return 'A catalog price is invalid';
  if (!v.sameUnit) return 'Catalog price units differ';
  if (!v.distinct) return 'Catalog identities conflict';
  return 'Comparable catalog prices are ready';
};
export const step = action => ({Select:'compare exact prices',Refuse:'refuse incomplete evidence',Done:'finish'})[action] ?? action;
