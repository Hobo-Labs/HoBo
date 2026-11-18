export const title = 'Write a status site';
export const state = (v) => ({ checking: 'Validate all page slugs', rejected: 'Batch rejected without writes', writing: 'Write validated pages', done: 'Site written' })[v.phase];
export const step = (action) => ({ Check: 'validate next slug', Prepare: 'finish validation', EarlyRoot: 'create site root', Write: 'write page', Wait: 'wait' })[action] ?? action;
