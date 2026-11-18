export const title = 'Reserve capacity before generating a Yard';
export const state = v => {
  const claim = v.claim[1];
  const label = ({none:'No quota reservation', pending:'Quota reserved for generation', ready:'Yard counted as ready'})[claim];
  return claim === 'ready' && !v.verified[1] ? `${label}: readiness not verified` : label;
};
export const step = (action, from, to) => ({
  Reserve:'reserve generation and Yard capacity',
  Ready:'record verified readiness',
  Stutter:'wait',
})[action] ?? null;
