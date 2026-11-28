export const title = 'Reconcile Yard generation evidence';
export const state = v => ({pending:'Generation awaiting funding',claimed:'Funding claimed',rematching:'Provider effect completed',resolved:'Generated Yard selected',rejected:v.executed?'Evidence unavailable; reconcile retained hold':'Generation refused'})[v.phase];
export const step = (a, from, to) => {
 if(a === 'Claim') return to.phase === 'claimed' ? 'claim funding' : 'refuse without funding';
 if(a === 'Provision') return 'start provider operation';
 if(a === 'Rematch') return to.phase === 'resolved' ? 'match with current evidence' : 'retain exposure for reconciliation';
 return 'finish';
};
