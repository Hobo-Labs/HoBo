export const title = 'Validate pricing source identity';
export const state = v => ({received:'Financial state received',rejected:'Quote rejected',accepted:'Sources accepted',applied:'Source value applied'})[v.phase];
export const step = action => ({Validate:'check tenant, identity and account',Apply:'apply source once',Done:'finish'})[action] ?? action;
