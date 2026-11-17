export const title = 'Sign and verify a broker resolution';
export const state = v => {
  if (v.phase === 'accepted') return v.mode === 'sign' ? 'Resolution signed' : 'Trusted signature accepted';
  if (v.phase === 'refused') return 'Signature evidence refused';
  if (!v.publicOnly) return 'Public key is invalid or contains private material';
  if (v.mode === 'sign') return v.signingMatch ? 'Signing keys match' : 'Signing keys disagree';
  if (!v.enrolled || !v.sameKey) return 'Signing key is not enrolled';
  if (!v.valid || !v.digest) return 'Signature or digest is invalid';
  return 'Signature and trusted key are ready';
};
export const step = action => ({Accept:'accept valid evidence',Refuse:'refuse invalid evidence',Done:'finish'})[action] ?? action;
