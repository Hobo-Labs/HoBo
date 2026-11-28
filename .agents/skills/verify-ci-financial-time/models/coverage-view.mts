export const title = 'Check CI financial time coverage';
export const state = v => {
  if (v.phase === 'accepted') return 'Time is covered';
  if (v.phase === 'refused') return 'Time is not covered';
  const bound = v.operation === 'admit' ? v.start + v.duration * 2 : v.start;
  return v.expiry >= bound ? 'Evidence covers the required time' : 'Evidence expires too early';
};
export const step = action => ({Accept:'accept coverage',Refuse:'refuse coverage',Done:'finish'})[action] ?? action;
