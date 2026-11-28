export const title = 'Resume a recorded workflow';
export const state = (v) => ({ received: 'Resume requested', checked: 'Recorded context verified', refused: 'Invalid context refused', done: v.outcome === 'reused' ? 'Recorded outcome returned' : 'Workflow resumed' })[v.phase];
export const step = (action) => ({ Check: 'check the recorded context', Continue: 'resume or return the recorded outcome', Done: 'wait' })[action] ?? action;
