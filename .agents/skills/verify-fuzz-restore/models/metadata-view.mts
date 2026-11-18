export const title = 'Protect fuzz restore metadata';
export const state = (v) => {
  if (v.phase === 'rolled' && v.liveState !== v.replayState) return 'Rollback replay differs';
  if (v.liveClock !== v.replayClock) return 'Restore clock differs from replay';
  if (v.target !== 0) return 'Rollback metadata changed by caller';
  if (['baseline-checked', 'snapshot'].includes(v.phase) && v.baseline !== 1) return 'Replay baseline changed by caller';
  return ({ fresh: 'Fresh oracle', 'target-checked': 'Rollback metadata protected', restored: 'Snapshot restored', 'baseline-checked': 'Replay baseline protected', snapshot: 'Checkpoint recorded', rolled: 'Checkpoint restored' })[v.phase];
};
export const step = (action) => ({ AttemptTarget: 'caller tries to edit rollback metadata', Restore: 'restore snapshot', AttemptBaseline: 'caller tries to edit replay baseline', Snapshot: 'record checkpoint and change state', Rollback: 'restore checkpoint', Wait: 'wait' })[action] ?? action;
