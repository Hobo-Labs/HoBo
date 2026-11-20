export const title = 'Stop fan-out after a mandatory failure';
export const state = (v) => v.phase === 'ready'
  ? 'Release awaits scheduling'
  : v.status.pilot === 'failed' || v.status.canary === 'failed'
    ? 'Mandatory failure stops new starts'
    : 'Eligible Camps may be scheduled';
export const step = (_action, _from, to) =>
  to.status.pilot === 'failed' || to.status.canary === 'failed'
    ? 'a mandatory Camp has failed'
    : 'no mandatory Camp has failed';
