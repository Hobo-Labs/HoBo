export const title = 'Check whether a runner scan is complete';
export const state = v => {
 if (v.phase === 'done') return v.allowed ? 'Teardown allowed' : 'Runner retained';
 if (v.found) return 'Executing job observed';
 if (v.result === 'incomplete') return 'Scan limit reached';
 if (v.result === 'complete') return 'Listing exhausted';
 return 'Scanning jobs';
};
export const step = action => ({ Observe:'read next job', Exhaust:'confirm listing exhausted', Truncate:'detect more work beyond limit', Decide:'apply teardown policy', Done:'finish' })[action] ?? action;
