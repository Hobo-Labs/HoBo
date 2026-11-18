export const title = 'Require readiness before selecting a generated Yard';
export const state = v => ({
  result: 'Provider result received',
  reconcile: v.warning ? 'Hold retained with reconciliation warning' : 'Hold marked uncertain',
  placed: v.resultReady || (v.signalReady && v.signalBound) ? 'Ready Yard accepted' : 'Unready Yard accepted',
})[v.phase];
export const step = (action, from, to) => ({
  Decide: to.phase === 'placed' ? 'accept the Yard' : to.warning ? 'retain the hold and report the failed write' : 'mark the hold uncertain',
  Done: 'finish',
})[action] ?? null;
