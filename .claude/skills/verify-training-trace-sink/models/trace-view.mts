export const title = 'Record and drain training traces';
export const state = (v) => Object.keys(v.queue).length > 0 ? 'Spans queued' : v.drains > 0 ? 'Queue drained' : 'Queue empty';
export const step = (action) => ({ Record: 'record span', MutateName: 'edit source span', MutateAttr: 'edit source attributes', Drain: 'drain queue', Wait: 'wait' })[action] ?? action;
