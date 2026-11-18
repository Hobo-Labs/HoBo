export const title = 'Recover from a failed test graph startup';
export const state = (v) => {
  if (v.tampered && v.phase === 'blocked') return 'Cleanup retry changed by caller';
  if (v.replacementStarted && v.oldOpen) return 'Replacement overlaps a leaked listener';
  if (['clean', 'redeployed'].includes(v.phase) && v.oldOpen) return 'Startup failed but listener remains open';
  return ({starting: 'Starting test graph', opened: 'One listener open', cleaning: 'Closing opened listeners', blocked: 'Cleanup failed; listener still open', clean: 'Failed startup cleaned up', redeployed: 'Replacement deployment started'})[v.phase];
};
export const step = (action) => ({OpenListener:'open a listener', StartupFails:'startup fails', CleanupFails:'listener cleanup fails', Tamper:'caller tries to change the cleanup retry', RetryCleanup:'retry cleanup', CleanupSucceeds:'listener cleanup succeeds', Redeploy:'start replacement', Wait:'wait'})[action] ?? action;
