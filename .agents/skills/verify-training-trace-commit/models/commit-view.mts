export const title = 'Commit training traces';
export const state = (v) => ({ new: 'Run requested', running: 'Building candidate and trace batch', validated: 'Candidate validated', failed: 'Run failed with queue unchanged', done: 'Trace batch committed' })[v.phase];
export const step = (action) => ({ Start: 'start run', Step: 'score proposal', Validate: 'validate candidate', Fail: 'run fails', Commit: 'append trace batch', Wait: 'wait' })[action] ?? action;
