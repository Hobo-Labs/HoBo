export const title = 'Read a workflow journal';
export const state = (v) => ({ received: 'Journal received', checked: 'Stream identity verified', refused: 'Foreign stream refused', done: 'Journal used' })[v.phase];
export const step = (action) => ({ Check: 'verify stream identity', Use: 'use verified journal', Done: 'wait' })[action] ?? action;
