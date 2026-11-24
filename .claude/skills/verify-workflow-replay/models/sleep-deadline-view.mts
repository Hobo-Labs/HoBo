export const title = 'Wait for a workflow sleep deadline';
export const state = v => {
 if (v.phase === 'new') return 'Sleep requested';
 if (v.phase === 'crashed') return 'Host stopped';
 if (v.phase === 'done') return 'Deadline reached';
 return 'Waiting for deadline';
};
export const step = action => ({
 Schedule:'record deadline',
 Advance:'clock advances',
 Wake:'recheck deadline',
 Crash:'host stops',
 Resume:'resume with recorded deadline',
 Done:'finish',
})[action] ?? action;
