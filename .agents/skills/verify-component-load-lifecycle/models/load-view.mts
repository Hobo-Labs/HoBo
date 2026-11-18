export const title = 'Load a local component';
export const state = (v) => ({ missing: 'Component absent', loading: 'Component loading', loaded: 'Component loaded', failed: 'Load refused or failed', 'torn-down': 'Component torn down' })[v.phase];
export const step = (action) => ({ Begin: 'request load', Edit: 'descriptor changes', Reenter: 'second load requested', Finish: 'finish instantiation', Fail: 'instantiation fails', Retry: 'retry load', Duplicate: 'second load requested', Teardown: 'tear down component', Done: 'wait' })[action] ?? action;
