export const title = 'Use one workflow run identity';
export const state = (v) => {
  if (v.inspected) return 'Invalid ID inspected';
  if (!['string-one', 'string-two'].includes(v.kind) && v.phase === 'accepted') return 'Invalid run ID accepted';
  if (!['string-one', 'string-two'].includes(v.kind) && v.phase === 'accessed') return 'Invalid run ID used';
  return ({ new: 'Run ID received', invalid: 'Invalid run ID refused', accepted: 'Valid run ID accepted', accessed: 'Journal accessed' })[v.phase];
};
export const step = (action, from, to) => ({
  Check: to.phase === 'accepted' && !['string-one', 'string-two'].includes(from.kind) ? 'accept invalid ID' : 'validate ID',
  Access: 'access journal',
  Done: 'wait',
})[action] ?? action;
