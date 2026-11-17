export const title = 'Bind selected definitions to resources';
export const state = v => ({input:'Resource placements ready',bound:'Each resource has its selected definition',rejected:'Duplicate resources refused'})[v.phase];
export const step = a => ({Bind:'record exact associations',Refuse:'refuse duplicate identities',Done:'finish'})[a] ?? a;
