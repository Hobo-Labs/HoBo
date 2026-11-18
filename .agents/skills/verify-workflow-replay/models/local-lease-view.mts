export const title = 'Coordinate local workflow executions';
export const state = (v) => {
  if (v.owner === 'none') return 'Run available for execution';
  if (v.phase[v.owner] === 'returned') return 'Parent exited while command is pending';
  if (v.pending[v.owner]) return 'Execution has an active command';
  return 'Execution owns local fence';
};
export const step = (action) => ({ Start: 'claim run', BeginCommand: 'start durable command', FinishParent: 'parent exits', DrainCommand: 'command settles', Done: 'wait' })[action] ?? action;
