export const title = 'Restore a fuzz oracle state';
export const state = (v) => {
  if (v.phase === 'requested') return 'Restore requested';
  if (v.phase === 'rejected') return v.value !== v.original || v.clock !== v.oldClock ? 'Restore rejected after state changed' : 'Restore rejected with state unchanged';
  if (!v.valid) return v.phase === 'restored' ? 'Invalid snapshot restored' : 'Invalid snapshot replayed';
  if (!v.fresh && (v.clock <= v.oldClock || v.clock <= v.sourceClock)) return v.phase === 'restored' ? 'Snapshot restored without a new clock' : 'History replayed without a new clock';
  if (v.phase === 'replayed' && v.replayed !== v.value) return 'History replayed with different state';
  return v.phase === 'restored' ? 'Snapshot restored' : 'History replayed';
};
export const step = (action, _from, to) => action === 'Attempt' ? (to.phase === 'rejected' ? 'reject snapshot' : 'restore snapshot') : ({ Replay: 'replay history', Wait: 'wait' })[action] ?? action;
