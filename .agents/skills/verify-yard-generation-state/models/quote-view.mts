export const title = 'Bind a quote to the exact Yard';
export const state = v => ({ received: 'Yard quote requested', refused: 'Wrong exact Yard refused', quoted: 'Yard work prepared for quote' })[v.phase];
export const step = (action, from, to) => ({ Quote: to.phase === 'refused' ? 'refuse the wrong or missing Yard' : 'prepare work for the selected Yard', Done: 'finish' })[action] ?? null;
