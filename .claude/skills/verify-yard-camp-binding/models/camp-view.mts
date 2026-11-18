export const title = 'Select a Camp inside the chosen Yard';
export const state = v => ({
  parse: 'Camp placement requested',
  select: 'Yard selected; Camp under review',
  selected: 'Camp selected inside Yard',
  allowed: 'Local hosting approved',
  issued: 'Placement receipt issued',
  rejected: 'Placement refused',
})[v.phase];
export const step = (action, from, to) => ({
  Parse: to.phase === 'rejected' ? 'refuse an invalid environment' : 'capture the requested Camp',
  Select: to.phase === 'rejected' ? 'refuse a Camp outside the Yard' : 'select the requested Camp',
  EditSource: null,
  Authorize: to.phase === 'rejected' ? 'hosting policy refuses' : 'hosting policy approves',
  Issue: 'issue the placement receipt',
  Done: 'finish',
})[action] ?? null;
