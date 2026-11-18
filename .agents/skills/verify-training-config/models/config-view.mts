export const title = 'Validate and run a training configuration';
export const state = (v) => ({ new: 'Configuration supplied', refused: 'Configuration rejected', running: 'Optimizer running', done: 'Optimizer completed' })[v.phase];
export const step = (action) => ({ Start: 'validate configuration', Advance: 'run optimizer step', Wait: 'wait' })[action] ?? action;
