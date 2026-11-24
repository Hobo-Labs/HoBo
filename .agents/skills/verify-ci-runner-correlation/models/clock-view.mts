export const title = 'Apply queued-runner grace';
export const state = v => {
 if (v.phase === 'observed') return 'Queued job observed';
 return v.blocked ? 'Runner retained' : 'Teardown allowed';
};
export const step = action => ({Decide:'evaluate grace period', Done:'finish'})[action] ?? action;
