export const title = 'Record a component event';
export const state = (v) => ({ ready: 'Host ready', emitting: 'Event being recorded', done: 'Event recorded', uncertain: 'Host awaiting reconciliation' })[v.phase];
export const step = (action) => ({ Begin: 'record event', Reenter: 'callback requests host operation', Succeed: 'sink confirms', Fail: 'sink fails', AsyncReturn: 'sink returns an async result', AfterFailure: 'request new operation', Done: 'wait' })[action] ?? action;
