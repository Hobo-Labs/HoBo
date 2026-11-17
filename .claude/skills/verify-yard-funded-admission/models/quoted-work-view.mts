export const title = 'Fund the selected Yard work';
export const state = v => {
 if (v.phase === 'policy') return 'Work awaits a bound quote';
 if (v.phase === 'reserved') return 'Quoted work has a financial hold';
 if (v.phase === 'claimed') return 'Generation is claimed';
 if (v.phase === 'provisioned') return 'Provider operation completed';
 if (v.phase === 'issued') return 'Current work admitted';
 if (v.executed) return 'Changed work refused; reconcile the hold';
 return v.held ? 'Changed plan refused; hold retained' : 'Unquoted work refused';
};
export const step = (action, from, to) => {
 if (action === 'Reserve') return to.phase === 'reserved' ? 'reserve quoted work' : 'refuse an unbound quote';
 if (action === 'Claim') return to.phase === 'claimed' ? 'claim current generation' : 'refuse a changed plan';
 if (action === 'Provision') return to.phase === 'provisioned' ? 'run the current provider operation' : 'refuse a changed plan';
 if (action === 'Finalize') return to.phase === 'issued' ? 'admit current work' : 'retain exposure for reconciliation';
 return 'finish';
};
