export const title = 'Budget usage and recovery';
export const state = v => {
  if (v.signal === 'crossed') return 'Budget threshold crossed';
  if (v.signal === 'recovered') return 'Budget headroom restored';
  return v.crossed ? 'Spend remains above threshold' : 'Spend remains below threshold';
};
export const step = action => ({Usage:'record usage',Credit:'apply credit',Done:'finish'})[action] ?? action;
