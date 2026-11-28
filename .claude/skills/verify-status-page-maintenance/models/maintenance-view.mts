export const title = 'Track maintenance updates';
export const state = (v) => !v.scheduled ? v.pending === 'none' ? 'No schedule or update' : `Update received before schedule: ${v.pending}` : `Maintenance ${v.visible}`;
export const step = (action, _from, to) => action === 'Update' ? `receive ${to.scheduled ? to.visible : to.pending} update` : ({ Schedule: 'receive schedule', Wait: 'wait' })[action] ?? action;
