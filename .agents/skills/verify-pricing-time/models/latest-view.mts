export const title = 'Choose a latest measurement';
export const state = v => ({received:'Measurements received',rejected:'Ambiguous latest rejected',rated:'Latest value selected'})[v.phase];
export const step = action => ({Choose:'compare latest instants and values',Done:'finish'})[action] ?? action;
