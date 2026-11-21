export const title = 'Keep the mandatory pilot gate during catch-up';
export const state = (v) => {
  if (v.phase === 'ready') return 'Evaluate fan-out';
  if (v.candidates.includes('production')) return 'Production eligible';
  if (v.candidates.includes('pilot')) return 'Pilot eligible';
  return v.complete ? 'No eligible work now' : 'Pending or missing work';
};
export const step = (action) => ({ Decide: 'evaluate gates and slots', Done: 'wait' })[action] ?? action;
