export const title = 'Bind funded generation to its plan';
export const state = v => ({
  plan: 'Yard generation planned',
  refused: 'Wrong exact Yard refused',
  fund: 'Generation plan accepted',
  provider: 'Generation funding held',
  result: 'Provider called',
  reconcile: v.warning ? 'Hold retained with reconciliation warning' : 'Hold marked uncertain',
  placed: !v.yardMatches ? 'Receipt for wrong Yard' : !v.attemptMatches ? 'Receipt for wrong attempt' : 'Matching generation accepted',
})[v.phase];
export const step = (action, from, to) => ({
  Plan: to.phase === 'refused' ? 'refuse a different exact Yard' : 'accept the generation plan',
  Fund: 'reserve generation funding',
  Call: 'call the provider',
  Result: to.phase === 'placed' ? 'accept the provider result' : to.warning ? 'retain the hold and report the failed write' : 'mark the hold uncertain',
  Done: 'finish',
})[action] ?? null;
