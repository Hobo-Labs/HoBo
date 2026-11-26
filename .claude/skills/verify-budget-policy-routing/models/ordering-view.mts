export const title = 'Replay a dispatcher decision across locales';
export const state = v => v.legacy ? ({ready:'Legacy input',recorded:'Legacy decision recorded',replayed:'Legacy decision replayed'})[v.phase] : ({ready:'New dispatch',recorded:'Ordering choice recorded',replayed:'Same ordering replayed'})[v.phase];
export const step = action => ({Select:'select and record ordering',Replay:'replay on another host',Done:'finish'})[action] ?? action;
