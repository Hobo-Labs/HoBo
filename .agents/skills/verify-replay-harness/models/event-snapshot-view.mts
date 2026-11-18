export const title = 'Replay from captured event history';
export const state = (v) => ({ new: 'Event history received', captured: 'Event history captured', live: 'Live fold completed', replayed: 'Replay fold completed', done: 'Captured read set reported' })[v.phase];
export const step = (action) => ({ Capture: 'capture events', Live: 'run live fold', Mutate: 'caller edits original events', Replay: 'run replay fold', Report: 'report captured read set', Done: 'wait' })[action] ?? action;
