export const title = 'Record a workflow sleep completion';
export const state = v => {
 if (v.returned) return 'Sleep returned';
 if (v.phase === 'crashed') return v.fact ? 'Completion committed; response lost' : 'Host stopped before completion';
 if (v.fact) return 'Completion recorded';
 return 'Waiting for deadline';
};
export const step = action => ({
 Advance:'clock advances',
 Write:'record completion or lose response',
 Crash:'host stops',
 Resume:'resume and read journal',
 Return:'return after completion',
 Done:'finish',
})[action] ?? action;
