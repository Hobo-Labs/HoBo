export const title = 'Validate replay identities';
export const state = (v) => ({ received: 'Identity received', accepted: 'Identity accepted', refused: 'Invalid identity refused' })[v.phase];
export const step = (action) => ({ Check: 'check identity', Done: 'wait' })[action] ?? action;
