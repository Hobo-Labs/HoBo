export const title = 'Verify the same resolution across hosts';
export const state = v => v.phase === 'pending' ? 'The same resolution reaches both hosts' : v.accepted ? 'The trusted signature verifies' : 'The same resolution fails verification';
export const step = action => ({Verify:'compare the canonical payload',Done:'finish'})[action] ?? action;
