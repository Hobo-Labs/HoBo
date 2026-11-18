export const title = 'Validate a workflow journal';
export const state = (v) => ({ received: 'Journal received', checked: 'History validated', refused: 'Damaged history refused', used: 'History used' })[v.phase];
export const step = (action) => ({ Check: 'check visible history', Use: 'resume or replay', Done: 'wait' })[action] ?? action;
