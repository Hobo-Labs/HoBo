export const title = 'Refuse unverified Camp requirements before work';
export const state = v => ({
  received: v.path === 'quote' ? 'Quote requested' : 'Deployment requested',
  refused: 'Unverified Camp requirements refused',
  checked: v.path === 'quote' ? 'Quote requirements checked' : 'Deployment requirements checked',
  authorized: 'Host authorized placement',
  held: 'Budget held for generation',
  done: v.quoted ? 'Quote prepared' : 'Provider called',
})[v.phase];
export const step = (action, from, to) => ({
  Validate: to.phase === 'refused' ? 'refuse unverified requirements' : 'continue without unverified requirements',
  Quote: 'prepare a quote',
  Authorize: 'authorize the placement',
  Hold: 'hold the generation budget',
  Call: 'call the provider',
  Done: 'finish',
})[action] ?? null;
