export const title = 'Keep parsed replay evidence stable';
export const state = (v) => ({ received: 'Report received', parsed: 'Validated evidence available' })[v.phase];
export const step = (action) => ({ Parse: 'parse and protect the evidence', EditInput: 'caller edits the original', EditVector: 'caller edits reported positions', EditEntry: 'caller edits a position', EditMarker: 'caller edits the version', Done: 'wait' })[action] ?? action;
