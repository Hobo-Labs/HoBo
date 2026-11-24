export const title = 'Two CI jobs reserve shared capacity';
export const state = v => v.reservations === 0 ? 'Both jobs read capacity' : (v.attempted.length === 2 ? 'Stale reservation refused' : 'One reservation recorded');
export const step = action => action.startsWith('Reserve') ? 'reserve one slot' : action.startsWith('RefuseStale') ? 'refuse stale capacity view' : 'finish';
