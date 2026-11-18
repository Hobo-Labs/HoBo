export const title = 'Validate build timestamp';
export const state = (v) => ({ requested: 'Build requested', rejected: 'Timestamp rejected', ready: 'Timestamp accepted', started: 'Build starts' })[v.phase];
export const step = (action, _from, to) => action === 'Check' ? (to.phase === 'rejected' ? 'reject invalid timestamp' : 'accept timestamp') : ({ Start: 'start build', Wait: 'wait' })[action] ?? action;
