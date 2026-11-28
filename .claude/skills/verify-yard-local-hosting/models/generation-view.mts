export const title = 'Fund Yard generation before provisioning';
export const state = v => ({pending:'Yard generation requested',started:'Funded generation may start',rejected:'Generation refused'})[v.phase];
export const step = (a, from, to) => a === 'Decide' ? (to.phase === 'started' ? 'durable funding confirmed' : 'funding missing') : 'finish';
