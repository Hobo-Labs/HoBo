export const title = 'Authorize a pricing quote';
export const state = v => {
  if (v.phase === 'approved') return 'Pricing evidence accepted';
  if (v.phase === 'refused') return 'Pricing evidence refused';
  if (!v.valid) return 'Pricing evidence is invalid';
  if (v.mode === 'legacy') return v.trustedEstimate ? 'Legacy estimate is explicitly trusted' : 'Legacy estimate has no trust';
  if (v.mutated) return 'Quote changed during attestation';
  return v.attested ? 'Quote is attested by the host' : 'Quote has no host attestation';
};
export const step = action => ({Approve:'accept evidence',Refuse:'refuse evidence',Done:'finish'})[action] ?? action;
