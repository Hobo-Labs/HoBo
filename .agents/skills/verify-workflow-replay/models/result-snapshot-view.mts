export const title = 'Save a reproducible workflow or step result';
export const state = (v) => {
  if (v.phase === 'captured' && !v.valid) return 'Unreplayable result accepted';
  if (v.phase === 'recorded' && !v.valid) return 'Unreplayable result recorded';
  if (v.phase === 'recorded' && v.recorded !== v.captured) return 'Different result recorded';
  if (v.phase === 'returned' && v.returned !== v.recorded) return 'Different result returned';
  return ({
    produced: 'Result produced',
    captured: 'Result captured',
    rejected: 'Unreplayable result failed',
    recorded: 'Result recorded',
    returned: 'Recorded result returned',
    crashed: 'Host stopped after recording',
    replayed: 'Recorded result replayed',
  })[v.phase];
};
export const step = (action, from, to) => ({
  Capture: !from.valid && to.phase === 'captured' ? 'accept unreplayable result' : 'validate and capture result',
  Mutate: 'producer edits original result',
  Record: 'store captured result',
  Return: to.returned === from.captured ? 'return captured result' : 'return edited original result',
  Crash: 'host stops',
  Resume: 'return recorded result',
  Done: 'wait',
})[action] ?? action;
