export const title = 'Authorize Yard generation';
export const state = v => {
 if (v.phase === 'held') return 'Generation awaits current authority';
 if (v.phase === 'claimed') return 'Generation authority claimed';
 if (v.phase === 'provisioned') return 'Provider operation completed';
 if (v.phase === 'issued') return 'Generated Yard admitted';
 return v.executed ? 'Changed authority refused; reconcile the hold' : 'Changed authority refused; hold retained';
};
export const step = (action, from, to) => {
 if (action === 'Claim') return to.phase === 'claimed' ? 'claim current authority' : 'refuse changed policy, runtime or connector';
 if (action === 'Provider') return to.phase === 'provisioned' ? 'run the provider operation' : 'refuse changed authority';
 if (action === 'Finalize') return to.phase === 'issued' ? 'admit current generation' : 'retain exposure for reconciliation';
 return 'finish';
};
