export const title = 'Route work within a shared budget';
export const state = v => {
  const r=v.reservation.a, p=v.pc.a;
  if (r==='pending') return 'Budget reserved';
  if (r==='running') return 'Work running with budget held';
  if (r==='confirmed') return v.overrunSeen ? 'Usage settled with provider overrun' : 'Usage settled';
  if (r==='released') return 'Reservation released';
  if (r==='expired') return 'Reservation expired';
  return ({idle:'Ready to route',read:'Checking budget',selected:'Provider selected',rejected:'Request declined'})[p];
};
export const step = (action, from, to) => {
  if (action === 'Retry' && to.pc.a === 'rejected') return 'budget changed; retry limit reached';
  if (action === 'Confirm') {
    const evidence = from.reservation.a === 'running' ? 'after final usage evidence' : 'before work starts';
    return to.overrunSeen && !from.overrunSeen ? `record provider overrun ${evidence}` : `settle usage ${evidence}`;
  }
  const labels={Read:'read budget',Select:'select an eligible provider',Reject:'no affordable provider',Reserve:'reserve budget',Retry:'budget changed; retry',Start:'start work',ObserveFinal:'receive final usage evidence',Release:'cancel before start',Expire:'reservation expires',Confirm:'settle usage',Replay:'retry request',Done:'finish'};
  return labels[action] ?? action;
};
