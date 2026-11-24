export const title = 'Check runner work across GitHub runs';
export const state = v => {
 if (v.phase === 'done') return v.blocked ? 'Runner retained' : 'Teardown allowed';
 if (v.phase === 'observed') return v.incomplete ? 'Lookup incomplete' : v.selected === 'executing' ? 'Executing job observed' : 'No execution observed';
 return 'Checking runs';
};
export const step = action => ({ ObserveFirst:'check preferred run', Complete:'check later runs', Fail:'later lookup fails', DirectFailure:'served-job lookup fails', Decide:'apply teardown policy', Done:'finish' })[action] ?? action;
