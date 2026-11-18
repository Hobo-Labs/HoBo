export const title = 'Capture replay evidence before checking it';
export const state = (v) => ({ received: 'Evidence received', captured: 'Evidence captured', checked: 'Captured evidence checked', accepted: 'Captured evidence decoded' })[v.phase];
export const step = (action) => ({ CaptureInput: 'capture the input', Check: 'check the captured input', Edit: 'caller changes the original', Decode: 'decode the checked input', Done: 'wait' })[action] ?? action;
