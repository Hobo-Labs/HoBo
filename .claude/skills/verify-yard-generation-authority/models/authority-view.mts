export const title = 'Authorize Yard generation';
const changed = v => !v.policy ? 'policy' : !v.runtime ? 'runtime' : !v.connector ? 'connector' : null;
export const state = v => {
 if (v.phase === 'held') return 'Generation awaits current authority';
 if (v.phase === 'claimed') return changed(v) ? `Generation claimed with changed ${changed(v)}` : 'Generation authority claimed';
 if (v.phase === 'provisioned') return changed(v) || !v.effectCurrent ? 'Provider operation under changed authority' : 'Provider operation completed';
 if (v.phase === 'issued') return v.postCurrent ? 'Generated Yard admitted' : 'Generated Yard admitted after authority changed';
 return v.executed ? 'Changed authority refused; reconcile the hold' : 'Changed authority refused; hold retained';
};
export const step = (action, from, to) => {
 if (action === 'Claim') return to.phase !== 'claimed' ? 'refuse changed policy, runtime or connector' : changed(from) ? `claim despite changed ${changed(from)}` : 'claim current authority';
 if (action === 'Provider') return to.phase !== 'provisioned' ? 'refuse changed authority' : !from.effectCurrent ? 'run after authority changed' : 'run the provider operation';
 if (action === 'Finalize') return to.phase !== 'issued' ? 'retain exposure for reconciliation' : !from.postCurrent ? 'admit after authority changed' : 'admit current generation';
 return 'finish';
};
