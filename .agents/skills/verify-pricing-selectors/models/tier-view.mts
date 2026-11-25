export const title = 'Validate and rate tier ranges';
export const state = v => ({received:'Tier schedule received',validated:'Contiguous tiers accepted',rejected:'Invalid tiers rejected',rated:'Usage rated once'})[v.phase];
export const step = action => ({Validate:'check tier boundaries',Rate:'rate covered usage',Done:'finish'})[action] ?? action;
