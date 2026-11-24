export const title = 'Resume a workflow terminal result';
export const state = v => {
 if (v.decision === 'accepted') return 'Terminal result returned';
 if (v.decision === 'rejected') return 'Invalid history refused';
 if (v.fact === 'none') return 'Workflow running';
 return v.evidence ? 'Terminal evidence recorded' : 'Terminal evidence damaged';
};
export const step = action => ({
 AppAttempt:'application event attempted',
 EngineFinish:'record runtime outcome',
 DamageEvidence:'history damaged',
 Resume:'validate and resume',
 Done:'finish',
})[action] ?? action;
