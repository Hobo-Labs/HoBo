export const title = 'Keep local authorization current';
export const state = v => ({awaiting:'Host policy is being evaluated',checked:'Approval returned to broker',approved:'Current approval reaches receipt',rejected:'Changed context refused'})[v.phase];
export const step = (a, from, to) => {
 if(a === 'Check') return to.phase === 'checked' ? 'confirm callback context' : 'refuse changed context';
 if(a === 'Finish') return to.phase === 'approved' ? 'recheck before receipt' : 'refuse a later change';
 return 'finish';
};
