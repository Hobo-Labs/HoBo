export const title = 'Use a captured workflow definition';
export const state = (v) => ({ received: 'Workflow requested', waiting: 'Definition captured', executed: 'Captured definition used' })[v.phase];
export const step = (action) => ({ Capture: 'capture workflow definition', Edit: 'caller changes the original', Use: 'use captured definition', Done: 'wait' })[action] ?? action;
