export const title = 'Read replay evidence from protobuf';
export const state = (v) => ({ received: 'Replay evidence received', decoded: 'Wire evidence decoded', accepted: 'Validated evidence available', refused: 'Invalid evidence refused' })[v.phase];
export const step = (action) => ({ Decode: 'decode or refuse the wire input', Validate: 'validate the decoded evidence', Done: 'wait' })[action] ?? action;
