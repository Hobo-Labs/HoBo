export const title = 'Try the cheapest affordable quote';
export const state = v => ({gate:'Policy decision pending',first:'Cheapest candidate at billing',second:'Next candidate at billing',resolved:'Placement funded',rejected:'Request refused'})[v.phase];
export const step = (a, from, to) => {
  if (a === 'Gate') return to.phase === 'first' ? 'policy allows' : 'policy refuses';
  if (a === 'First') return to.phase === 'second' ? 'safe budget denial' : to.phase === 'resolved' ? 'authorize cheapest candidate' : 'ambiguous denial';
  if (a === 'Second') return to.phase === 'resolved' ? 'authorize next candidate' : 'next candidate unaffordable';
  return a === 'Done' ? 'finish' : a;
};
