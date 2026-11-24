export const title = 'Quote and select by financial completeness';
export const state = v => ({received:'Financial state received',quoted:'Quote produced',rejected:'Quote rejected',selected:'Candidate selected','not-selected':'Candidate not selected'})[v.phase];
export const step = action => ({Quote:'check completeness and quote',Dispatch:'check eligibility',Done:'finish'})[action] ?? action;
