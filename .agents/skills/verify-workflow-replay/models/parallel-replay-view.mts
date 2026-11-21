export const state = v => ({
  checking: 'Parallel journal read',
  running: 'Scheduled gap accepted',
  'replaying-later': 'Earlier step resumed',
  completed: 'Recorded later result reused',
  rejected: 'Inconsistent journal refused',
})[v.phase];

export const step = action => ({
  Check: 'validate missing outcome',
  ResumeEarlier: 'validate name and resume step',
  ResumeLater: 'reuse recorded result',
})[action] ?? action;
