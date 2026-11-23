export const title = 'Rate the same credit state on two hosts';
export const state = v => v.doneEn && v.doneSv ? 'Quotes agree' : (v.doneEn || v.doneSv ? 'One host rated' : 'Same credit state');
export const step = action => ({RateEn:'rate on English host',RateSv:'rate on Swedish host',Done:'finish'})[action] ?? action;
