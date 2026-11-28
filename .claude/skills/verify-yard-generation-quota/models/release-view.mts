export const title = 'Release unused Yard generation capacity safely';
export const state = v => {
 const base=({pending:'Generation quota reserved',claimed:'Execution fence claimed',cancelled:'Unused quota released',ready:'Yard readiness verified'})[v.phase];
 const faults=[];
 if(v.phase==='cancelled' && v.winners.length) faults.push('claimed work released');
 if(v.reused) faults.push('cancelled key reused');
 if(v.called.length>1) faults.push('provider called twice');
 if(faults.length) return `${base}: ${faults.join(', ')}`;
 return v.phase==='claimed' && v.called.length ? 'Provider call started; quota retained' : base;
};
export const step = (action,from,to) => ({ClaimFirst:'claim execution for one caller',ClaimRetry:'claim execution for one caller',Claim:'claim execution for one caller',DuplicateClaim:'claim execution twice',Cancel:'release unused quota',Reuse:'reuse a cancelled key',CallFirst:'call the provider',CallRetry:'call the provider',Call:'call the provider',Ready:'verify readiness',Done:'finish'})[action] ?? null;
