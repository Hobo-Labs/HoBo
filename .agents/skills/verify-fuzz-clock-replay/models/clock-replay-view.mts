export const title = 'Change fuzz oracle clock';
export const state = (v) => {
  if (v.liveClock < 0) return 'Clock moved backward';
  if (['replayed-clock', 'snapshot', 'rolled'].includes(v.phase) && v.liveClock !== v.replayClock) return v.phase === 'rolled' ? 'Rollback history differs' : 'Replay clock differs';
  return ({ requested: 'Clock change requested', rejected: 'Clock change rejected', changed: 'Clock changed', 'replayed-clock': 'Clock replayed', snapshot: 'Checkpoint recorded', rolled: 'Checkpoint restored' })[v.phase];
};
export const step = (action, _from, to) => action === 'Attempt' ? (to.phase === 'rejected' ? 'reject invalid change' : 'change clock') : ({ ReplayClock: 'replay clock change', Snapshot: 'record checkpoint and change state', Rollback: 'restore checkpoint', Wait: 'wait' })[action] ?? action;
