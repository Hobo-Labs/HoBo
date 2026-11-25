export const title = 'Match a GitHub job to its runner';
export const state = v => {
 if (v.phase === 'observed') return 'Runner and job observed';
 return v.matched ? 'Runner matches' : 'Runner does not match';
};
export const step = action => ({Correlate:'compare IDs or available names', Done:'finish'})[action] ?? action;
