export const title = 'Select a training candidate';
export const state = (v) => ({ new: 'Request supplied', refused: 'Invalid rewards rejected', running: 'Scoring proposals', done: 'Best candidate selected' })[v.phase];
export const step = (action) => ({ Start: 'validate rewards', AnyStep: 'score proposal', Finish: 'return winner', Wait: 'wait' })[action] ?? action;
