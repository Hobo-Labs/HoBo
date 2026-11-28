export const title = 'Record and read component events';
export const state = (v) => ({ before: 'No event yet', emitting: 'Event being recorded', stored: 'Event in diagnostic mirror' })[v.phase];
export const step = (action) => ({ Begin: 'begin recording event', SinkEdit: 'sink edits its event', Finish: 'sink confirms', Read: 'read diagnostic mirror', EditRecord: 'edit returned event', ClearArray: 'clear returned array', Wait: 'wait' })[action] ?? action;
