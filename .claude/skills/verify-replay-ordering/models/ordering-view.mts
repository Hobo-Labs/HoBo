export const title = 'Write and read replay ordering evidence';
export const state = (v) => ({ requested: 'Replay evidence requested', encoded: 'Versioned evidence produced', read: 'Evidence interpreted', refused: 'Unknown version refused' })[v.phase];
export const step = (action) => ({ Encode: 'encode or refuse the requested version', ReadMarked: 'read the recorded version', ReadLegacy: 'read historical evidence', Done: 'wait' })[action] ?? action;
