export const title = 'Deploy and tear down a test graph';
export const state = (v) => {
  const problems = [];
  if (v.initialStarts !== 1) problems.push('Duplicate initial deployment');
  if (v.restarted && !['closed', 'restarted'].includes(v.phase)) problems.push('Replacement overlaps teardown');
  if (v.secondStopSucceeded && !['closed', 'restarted'].includes(v.phase)) problems.push('Teardown reported complete early');
  if (problems.length) return problems.join('; ');
  if (v.phase === 'closing-start') return v.restartRequested ? 'Waiting for startup; redeploy queued' : 'Waiting for startup before teardown';
  if (v.phase === 'closing') return v.restartRejected ? 'Tearing down; redeploy refused' : v.restartRequested ? 'Tearing down; redeploy queued' : 'Tearing down';
  if (v.phase === 'failed') return v.restartRejected ? 'Teardown failed; redeploy refused' : 'Teardown failed; retry required';
  if (v.phase === 'closed') return v.restartRequested && !v.restartRejected ? 'Teardown complete; redeploy waiting' : 'Teardown complete';
  return ({starting: 'Deployment starting', running: 'Deployment active', restarted: 'Replacement deployment started'})[v.phase];
};
export const step = (action, from) => ({
  Reenter: 'request deployment again while starting', RequestStop: 'request teardown',
  StartDone: 'startup completes', StopAgain: 'request teardown again',
  RequestRestart: from.phase === 'failed' ? 'request redeploy [after teardown failed]' : 'request redeploy [during teardown]',
  CloseFails: 'teardown fails', RetryClose: 'retry teardown', CloseSucceeds: 'teardown completes',
  Restart: 'start replacement', Wait: 'wait'
})[action] ?? action;
