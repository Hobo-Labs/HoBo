export const title = 'Validate a Yard residency attestation';
export const state = v => ({
  review: 'Residency requirement under review',
  eligible: 'Yard meets residency requirement',
  refused: 'Yard refused for residency',
})[v.phase];
export const step = (action, from, to) => ({
  Check: to.phase === 'eligible' ? 'accept valid residency evidence' : 'refuse invalid or insufficient evidence',
  Done: 'finish',
})[action] ?? null;
