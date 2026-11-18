export const title = 'Record and restore fuzz checkpoints';
export const state = (v) => {
  const hasCheckpoint = Object.values(v.saved).some((value) => value !== -1);
  if (!hasCheckpoint) return 'No checkpoint recorded';
  if (v.clock === 2) return 'Checkpoint recorded at revision limit';
  return v.lastTarget === -1 ? 'Checkpoint recorded' : 'Checkpoint restored';
};
export const step = (action) => ({ Retry: 'retry changes resource', Rollback: 'restore checkpoint', Snapshot: 'record checkpoint', Wait: 'wait' })[action] ?? action;
