export const title = 'Check generation policy before spending';
export const state = v => {
  const label = ({
  received: 'Yard generation requested',
  'effect-refused': 'Unsupported generation effect refused',
  'approval-refused': 'Unavailable approval refused',
  planned: 'Generation policy accepted',
  authorized: 'Host authorized generation',
  held: 'Generation budget held',
  called: 'Provider called',
  })[v.phase];
  if (['planned', 'authorized', 'held', 'called'].includes(v.phase)) {
    if (v.effect !== 'allow' && v.approval !== 'not-required') return `${label}: invalid effect and approval`;
    if (v.effect !== 'allow') return `${label}: invalid effect`;
    if (v.approval !== 'not-required') return `${label}: unavailable approval`;
  }
  return label;
};
export const step = (action, from, to) => ({
  Decide: to.phase === 'effect-refused' ? 'refuse the policy effect'
    : to.phase === 'approval-refused' ? 'refuse without approval' : 'accept the generation policy',
  Authorize: 'authorize generation',
  Hold: 'hold the generation budget',
  Call: 'call the provider',
  Done: 'finish',
})[action] ?? null;
