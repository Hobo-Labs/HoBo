export const title = 'Record nested command provenance';
export const state = v => {
 const count = Object.values(v.recorded).filter(value => value !== 'none').length;
 if (count === 2) return 'Both parents recorded';
 if (count === 1) return 'One parent recorded';
 return v.active.length ? 'Parent bodies active' : 'Parent steps scheduled';
};
export const step = action => ({
 Enter:'enter step body',
 Record:'record child parent',
 Exit:'leave step body',
 Done:'finish',
})[action] ?? action;
