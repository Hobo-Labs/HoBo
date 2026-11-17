export const title = 'Bill the complete CI host runtime';
export const state = v => v.phase === 'pending' ? 'Completed host runtime observed' : v.billed * 4 >= v.finish - v.start ? 'Complete runtime billed' : 'Some runtime is unbilled';
export const step = action => ({Bill:'round up and bill',Done:'finish'})[action] ?? action;
