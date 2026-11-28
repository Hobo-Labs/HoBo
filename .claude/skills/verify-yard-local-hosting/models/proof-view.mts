export const title = 'Authorize local hosting';
export const state = v => ({pending:'Local work awaits host approval',approved:'Bound zero-liability proof accepted',rejected:'Local placement refused'})[v.phase];
export const step = (a, from, to) => a === 'Evaluate' ? (to.phase === 'approved' ? 'approve bound zero-liability work' : 'refuse incomplete or denied proof') : 'finish';
