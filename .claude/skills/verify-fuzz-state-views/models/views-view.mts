export const title = 'Read fuzz oracle state';
export const state = (v) => {
  if (v.phase === 'rolled' && v.state !== v.history) return 'Rollback differs from history';
  if (v.checkpoint !== 0) return 'Stored checkpoint changed';
  if (v.state !== 0) return 'Stored state changed';
  return ({ ready: 'State available', viewed: 'State view returned', edited: 'Caller edits view', rolled: 'Checkpoint restored' })[v.phase];
};
export const step = (action) => ({ Read: 'read state', Edit: 'edit returned view', Rollback: 'restore checkpoint', Wait: 'wait' })[action] ?? action;
