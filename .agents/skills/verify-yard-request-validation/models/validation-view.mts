export const title = 'Validate placement requirements before authorization';
export const state = v => ({
  received: 'Placement request received',
  refused: 'Invalid request refused',
  parsed: 'Valid request captured',
  authorized: 'Captured request sent for host authorization',
})[v.phase];
export const step = (action, from, to) => ({
  Parse: to.phase === 'refused' ? 'refuse malformed requirements' : 'capture the requirements',
  Authorize: 'ask the host to authorize placement',
  Done: 'finish',
})[action] ?? null;
