export const title = 'Read component lifecycle';
export const state = (v) => ({ missing: 'Component missing', loaded: 'Component loaded', 'torn-down': 'Component torn down' })[v.actual];
export const step = (action) => ({ Load: 'load component', Read: 'read lifecycle', Edit: 'edit returned record', Teardown: 'tear down component', Wait: 'wait' })[action] ?? action;
