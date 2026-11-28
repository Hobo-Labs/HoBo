export const title = 'Verify a strict GitHub assignment';
export const state = v => v.phase === 'observed' ? 'GitHub evidence observed' : v.accepted ? 'Assignment verified' : 'Assignment unavailable';
export const step = action => ({Verify:'check scope, runner, group, labels and current job',Done:'finish'})[action] ?? action;
