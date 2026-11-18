export const title = 'Validate replay sequence positions';
export const state = (v) => ({ new: 'Sequence received', rejected: 'Unsafe sequence refused', validated: 'Sequence accepted', done: 'Replay work or parsing completed' })[v.phase];
export const step = (action) => ({ Validate: 'check numeric boundary', Execute: 'continue with safe positions', Done: 'wait' })[action] ?? action;
