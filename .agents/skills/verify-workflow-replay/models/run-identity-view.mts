export const title = 'Validate a workflow run identity';
export const state = (v) => ({ new: 'Run ID received', invalid: 'Invalid ID refused', conflict: 'Active run refused', accepted: 'Distinct run admitted', effect: 'Distinct run may execute' })[v.phase];
export const step = (action) => ({ Check: 'validate and check local fence', Effect: 'start execution', Done: 'wait' })[action] ?? action;
