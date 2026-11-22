export const title = 'Route using shared provider-account exposure';
export const state = (v) => ({
  unrouted: 'Read provider observations',
  admitted: 'Funded runner admitted',
  refused: 'Provider budget insufficient',
})[v.phase];
export const step = (action) => ({ Route: 'use highest exposure', Done: 'wait' })[action] ?? action;
