export const title = 'Claim a CI budget near a funded window boundary';
export const state = v => ({ready:'Work fits the funded window',claiming:'Claim waiting on financial store',committed:'Claim committed; recheck the window',allowed:'Execution may proceed',denied:'Execution refused; hold retained'})[v.phase];
export const step = (action, from, to) => to.phase === 'claiming' ? 'claim the financial hold' : to.phase === 'committed' ? 'claim commits' : to.phase === 'allowed' ? 'work still fits the window' : to.phase === 'denied' ? 'work no longer fits the window' : 'time passes';
