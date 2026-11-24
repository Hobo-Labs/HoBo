export const title = 'Rate workloads by their selectors';
export const state = v => ({received:'Workloads received',selected:'Matching charges selected',rejected:'Quote rejected',rated:'Groups rated'})[v.phase];
export const step = action => ({Select:'select per workload',Rate:'rate each group',Done:'finish'})[action] ?? action;
