export const title = 'Resume a workflow with terminal history';
export const state = (v) => {
  if (v.facts > 1 && v.phase === 'returned') return 'Conflicting outcome returned';
  if (v.phase === 'running' && v.calls > 0) return 'Workflow continued';
  return ({ checking: 'Journal read', rejected: 'Conflicting outcomes refused', returned: 'Recorded outcome returned', running: 'Workflow may continue' })[v.phase];
};
export const step = (action, from, to) => ({
  Check: to.phase === 'rejected' ? 'reject conflicting outcomes' : to.phase === 'returned' && from.facts > 1 ? 'return conflicting outcome' : to.phase === 'returned' ? 'return recorded outcome' : 'resume unfinished workflow',
  Run: 'continue workflow',
  Done: 'wait',
})[action] ?? action;
