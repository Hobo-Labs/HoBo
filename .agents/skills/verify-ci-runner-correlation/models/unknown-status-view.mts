export const title = 'Protect a runner when its job status is unknown';
export const state = v => {
 if (v.phase === 'done') return v.blocked ? 'Runner retained' : 'Teardown allowed';
 if (v.phase === 'observed') return v.selected === 'unknown' ? 'Status unknown' : v.selected === 'executing' ? 'Executing job observed' : v.incomplete ? 'Lookup incomplete' : 'No active job observed';
 return 'Checking assignments';
};
export const step = action => ({ ObserveFirst:'check preferred run', Complete:'check later runs', Fail:'later lookup fails', Decide:'apply custody and teardown policy', Done:'finish' })[action] ?? action;
