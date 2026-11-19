export const state = v => ({
  running: 'Replaying workflow',
  'handling-failure': 'Recorded step failed',
  'finishing-success': 'Workflow returned',
  'finishing-failure': 'Workflow failed',
  rejected: 'Inconsistent journal refused',
  completed: 'Completion recorded',
  failed: 'Failure recorded',
})[v.phase];

export const step = action => ({
  ReplayCompleted: 'consume completed step',
  ReplayFailed: 'consume failed step',
  CatchFailure: 'catch failure and compensate',
  PropagateFailure: 'propagate failure',
  BodySucceeded: 'workflow returns',
  BodyFailed: 'workflow fails',
  FinishSucceeded: 'validate before completion',
  FinishFailed: 'validate before failure',
})[action] ?? action;
