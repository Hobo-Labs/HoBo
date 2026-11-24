export const title = 'Reserve against the selected dispatch category';
export const state = v => v.bad ? (v.tries === 0 ? 'Inconsistent snapshot' : 'Admission quarantined') : (v.tries === 0 ? 'Ready to dispatch' : v.tries === 1 ? 'One funded start' : 'Second start blocked by budget');
export const step = action => ({Dispatch:'check history and reserve',Done:'finish'})[action] ?? action;
