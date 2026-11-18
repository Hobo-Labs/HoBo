export const title = 'Tear down a local component';
export const state = (v) => v.phase === 'torn-down' ? 'Component torn down' : v.pending > 0 ? 'Component call in progress' : v.started > 0 ? 'Calls settled' : 'Component ready';
export const step = (action) => ({ Start: 'start call', Settle: 'call settles', Teardown: 'tear down component', Done: 'wait' })[action] ?? action;
