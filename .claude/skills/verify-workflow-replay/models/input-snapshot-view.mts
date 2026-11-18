export const title = 'Capture workflow input before execution';
export const state = (v) => ({ new: 'Workflow input received', invalid: 'Unreplayable input refused', captured: 'Input captured', recorded: 'Journal bound to input', done: 'Captured work executed' })[v.phase];
export const step = (action) => ({ Capture: 'capture and validate input', Mutate: 'caller edits retained input', Record: 'bind or read journal input', Effect: 'execute captured input', Done: 'wait' })[action] ?? action;
