export const title = 'Track incident updates and late opens';
export const state = (v) => !v.present ? 'No incident' : !v.opened ? v.lifecycle === 'resolved' ? 'Resolved before its open' : 'Update received before its open' : v.lifecycle === 'resolved' ? 'Incident resolved' : 'Incident open';
export const step = (action, from, to) => action === 'Update' ? to.lifecycle === 'resolved' ? 'receive resolution' : 'receive update' : action === 'Open' ? to.lifecycle === 'resolved' && from.lifecycle !== 'resolved' ? 'receive resolved open' : 'receive open' : ({ Wait: 'wait' })[action] ?? action;
