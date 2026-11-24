export const title = 'Recover a workflow event append';
export const state = v => {
 if (v.phase === 'done') return 'Original event sequence returned';
 if (v.phase === 'stopped') return v.recorded ? 'Event committed, response lost' : 'Stopped before event commit';
 return v.recorded ? 'Event recorded' : 'Event not yet recorded';
};
export const step = action => ({
 LostBeforeCommit:'write response lost before commit',
 Write:'write event or lose response',
 Crash:'host stops',
 Resume:'resume and read journal',
 Return:'return recorded sequence',
 Done:'finish',
})[action] ?? action;
