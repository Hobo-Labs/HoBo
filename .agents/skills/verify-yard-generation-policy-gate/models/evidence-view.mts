export const title = 'Check generation evidence before spending';
export const state = v => {
  const label = ({
    received: 'Yard generation requested',
    'attestation-refused': 'Unavailable attestation refused',
    'locks-refused': 'Unverified property locks refused',
    planned: 'Generation policy accepted',
    authorized: 'Host authorized generation',
    held: 'Generation budget held',
    called: 'Provider called',
  })[v.phase];
  if (['planned', 'authorized', 'held', 'called'].includes(v.phase)) {
    if (v.attestation !== 'not-required' && v.locks !== 'none') return `${label}: missing attestation and property evidence`;
    if (v.attestation !== 'not-required') return `${label}: missing attestation`;
    if (v.locks !== 'none') return `${label}: unverified property lock`;
  }
  return label;
};
export const step = (action, from, to) => ({
  Decide: to.phase === 'attestation-refused' ? 'refuse without attestation'
    : to.phase === 'locks-refused' ? 'refuse unverified property locks' : 'accept the generation policy',
  Authorize: 'authorize generation',
  Hold: 'hold the generation budget',
  Call: 'call the provider',
  Done: 'finish',
})[action] ?? null;
