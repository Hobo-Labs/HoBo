export const state = v => ({
  checking: 'Journal read',
  running: 'Replaying workflow',
  'finishing-success': 'Workflow returned',
  'finishing-failure': 'Workflow failed',
  rejected: 'Inconsistent journal refused',
  completed: 'Completion recorded',
  failed: 'Failure recorded',
})[v.phase];

export const step = action => ({
  Check: 'validate outcome history',
  ReplayCompleted: 'consume completed step',
  ReplayFailed: 'consume failed step',
  BodySucceeded: 'workflow returns',
  BodyFailed: 'workflow fails',
  FinishSucceeded: 'validate before completion',
  FinishFailed: 'validate before failure',
})[action] ?? action;
