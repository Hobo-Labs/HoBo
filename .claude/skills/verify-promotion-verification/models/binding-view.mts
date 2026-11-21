export const title = 'Bind promotion retries to the recorded request';
export const state = (v) => {
  if (v.journal === 'empty') return 'Waiting for request claim';
  if (v.phase[1] === 'rejected') return 'Different request refused';
  if (v.phase[1] === 'accepted' || v.phase[1] === 'advanced') return 'Matching request accepted';
  return 'Request recorded';
};
export const step = (action) => ({ Read: 'read key', Append: 'claim or observe journal', Check: 'check recorded identity', Advance: 'advance matching request', Done: 'wait' })[action] ?? action;
