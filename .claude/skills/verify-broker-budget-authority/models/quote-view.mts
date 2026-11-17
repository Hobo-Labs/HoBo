export const title = 'Authorize quote or trusted estimate';
export const state = v => ({received:'Spend evidence received',authorized:'Spend authorized',denied:'Spend denied'})[v.phase];
export const step = action => ({Authorize:'check evidence and bounds',Done:'finish'})[action] ?? action;
