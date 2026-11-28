export const title = 'Verify an uncertain budget hold';
export const state = (v) => ({ checking: 'Checking uncertainty evidence', accepted: 'Uncertain hold verified', reconcile: 'Uncertain hold needs reconciliation' })[v.phase];
export const step = (action) => ({ Check: 'compare returned and stored evidence', Done: 'wait' })[action] ?? action;
