export const title = 'Build and use replay sequence boundaries';
export const state = (v) => {
  const selected = v.phase === 'selected';
  if (Object.keys(v.history).length === 0) return selected ? 'Own target entries selected' : 'No events recorded';
  return selected ? 'Events recorded and own target selected' : 'Events recorded';
};
export const step = (action) => ({ Add: 'record a stream sequence', Select: 'select own target entries', Done: 'wait' })[action] ?? action;
