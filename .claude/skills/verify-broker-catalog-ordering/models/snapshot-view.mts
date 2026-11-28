export const title = 'Check selected catalog evidence';
export const state = v => v.phase === 'selected' ? 'Selected evidence remains consistent' : v.phase === 'refused' ? 'Changed evidence refused' : v.priceStable && v.regionStable ? 'Selected evidence is unchanged' : 'Selected evidence has changed';
export const step = action => ({Select:'accept the selected evidence',Refuse:'refuse changed evidence',Done:'finish'})[action] ?? action;
