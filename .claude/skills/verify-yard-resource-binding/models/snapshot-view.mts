export const title = 'Keep the accepted resource request stable';
export const state = v => v.phase === 'bound' ? 'Original resources bound' : v.caller === 'changed' ? 'Caller changes its copy' : 'Accepted resources being resolved';
export const step = a => ({Mutate:'caller changes its copy',Bind:'bind accepted resources',Done:'finish'})[a] ?? a;
