export const title = 'Verify workflow replay context';
export const state = (v) => ({ new: 'Replay requested', captured: 'Input and callbacks captured', rejected: 'Recorded context refused', verified: 'Recorded context verified', done: 'Captured workflow replayed' })[v.phase];
export const step = (action) => ({ Capture: 'capture request', MutateCaller: 'caller edits input or callbacks', Validate: 'compare journal context', Execute: 'replay captured work', Done: 'wait' })[action] ?? action;
