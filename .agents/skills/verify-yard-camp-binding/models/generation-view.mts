export const title = 'Refuse a foreign Camp before Yard generation';
export const state = v => ({
  preflight: 'Planned Yard and Camp are checked',
  reserve: 'Camp fits the planned Yard',
  provision: 'Funding is held for generation',
  review: 'Generated Yard is checked',
  issued: 'Placement receipt issued',
  rejected: v.effect ? 'Placement refused; hold needs reconciliation' : 'Placement refused before generation',
})[v.phase];
export const step = (action, from, to) => ({
  Preflight: to.phase === 'rejected' ? 'refuse a foreign Camp' : 'accept the planned Camp',
  Reserve: 'reserve the budget',
  Provision: 'generate the Yard',
  Review: to.phase === 'rejected' ? 'refuse a changed Yard' : 'issue placement',
  Done: 'finish',
})[action] ?? null;
