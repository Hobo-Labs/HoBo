export const title = 'Validate workload and meter binding';
export const state = v => ({received:'Workload received',rejected:'Quote rejected',rated:'Binding accepted'})[v.phase];
export const step = action => ({Validate:'check product, meter and charge identities',Done:'finish'})[action] ?? action;
