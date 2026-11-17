export const title = 'Admit funded Yard hosting';
export const state = v => {
 if(v.phase === 'policy') return 'Quote awaits policy approval';
 if(v.phase === 'reserving') return 'Reserve the approved liability';
 if(v.phase === 'admitted') return 'Recheck before receipt';
 if(v.phase === 'resolved') return 'Funded receipt issued';
 return v.committed ? 'Changed evidence refused; hold retained' : 'Changed evidence refused before hold';
};
export const step = (a, from, to) => {
 if(a === 'Policy') return to.phase === 'reserving' ? 'confirm quote and policy context' : 'refuse changed evidence';
 if(a === 'Reserve') return to.phase === 'admitted' ? 'hold and check evidence' : 'retain hold for reconciliation';
 if(a === 'Finalize') return to.phase === 'resolved' ? 'issue current receipt' : 'retain hold for reconciliation';
 return 'finish';
};
