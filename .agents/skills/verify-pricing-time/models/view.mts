export const title = 'Check pricing evidence and expiry times';
export const state = v => !v.checked && !v.ordered ? 'Inputs loaded' : v.checked && v.ordered ? 'Exact checks complete' : (v.checked ? 'Evidence checked' : 'Expiry ordered');
export const step = action => ({Check:'check evidence interval',Order:'order credit expiry',Done:'finish'})[action] ?? action;
