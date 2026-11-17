export const title = 'Place a residual resource in its Yard';
export const state = v => ({checking:'Check resource capability and region',rechecking:'Recheck catalog evidence',selected:'Resource placed in Yard',rejected:'Resource placement refused'})[v.phase];
export const step = (a, from, to) => {
  if (a === 'Inspect') return to.phase === 'rechecking' ? 'full match in Yard' : 'no full match';
  if (a === 'Recheck') return to.phase === 'selected' ? 'evidence remains current' : 'catalog evidence changed';
  return a === 'Done' ? 'finish' : a;
};
