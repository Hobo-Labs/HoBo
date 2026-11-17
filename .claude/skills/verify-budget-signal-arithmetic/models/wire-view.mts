export const title = 'Represent a budget decision on the signal wire';
export const state = v => v.phase === 'accepted' ? 'Signal can be represented' : v.phase === 'refused' ? 'Signal refused for reconciliation' : v.exact === v.projected ? 'Wire preserves the decision' : 'Wire loses the decision';
export const step = action => ({Accept:'emit signal',Refuse:'require reconciliation',Done:'finish'})[action] ?? action;
