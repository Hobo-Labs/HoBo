export const title = 'Bind replay results to a captured boundary';
export const state = (v) => ({ new: 'Target received', captured: 'Target captured', selected: 'Events selected', done: 'Captured target reported' })[v.phase];
export const step = (action) => ({ Capture: 'capture own target entries', Select: 'select events', Mutate: 'caller edits original target', Report: 'report captured boundary', Done: 'wait' })[action] ?? action;
