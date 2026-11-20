export const title = 'Protect a shared provider allocation';
export const state = (v) => ({
  unrouted: 'Job awaits routing',
  admitted: 'Job admitted without shared credits',
  refused: 'Conflicting allocation cannot be used',
})[v.phase];
export const step = (_action, _from, to) => to.phase === 'admitted'
  ? 'reports contain no free allocation'
  : 'duplicate reports include free allocation';
