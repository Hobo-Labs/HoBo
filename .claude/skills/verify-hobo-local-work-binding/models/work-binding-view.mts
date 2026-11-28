export const title = 'Run only the local work placement approved';
export const state = v => {
 if (v.phase === 'snapshot') return 'Local deployment is requested';
 if (v.phase === 'review') return v.baseline === 2 ? 'Inputs were unavailable' : 'Project inputs are under review';
 if (v.phase === 'materialize') return 'Approved execution copy is being created';
 if (v.phase === 'approval') return v.execution === v.baseline ? 'Placement is authorizing the copied work' : 'Execution copy differs from approved inputs';
 if (v.phase === 'approved') return 'Placement approved the copied work';
 if (v.phase === 'preparing') return 'Local startup is being prepared';
 if (v.phase === 'launch-checked') return v.version === v.baseline ? 'Startup inputs were checked' : 'Working files changed after the final check';
 if (v.phase === 'worker-pending') return v.execution === v.baseline ? 'Worker is checking the execution copy' : 'Worker received a corrupted execution copy';
 if (v.phase === 'worker-checked') return v.workerObservation === v.baseline ? 'Worker verified the execution copy' : 'Worker accepted a corrupted execution copy';
 if (v.phase === 'started') return v.launched === v.baseline ? 'Approved copied work starts locally' : 'Different work starts locally';
 return 'Changed or unavailable inputs are refused';
};
export const step = (action, from, to) => {
 if (action === 'TakeSnapshot') return to.phase === 'rejected' ? 'refuse unavailable inputs' : 'capture input digest';
 if (action === 'Review') return to.phase === 'rejected' ? 'refuse changed inputs' : 'review the inputs';
 if (action === 'Materialize') return to.phase === 'rejected' ? 'refuse a changed copy source' : 'copy exact input bytes';
 if (action === 'Authorize') return 'approve the copied work';
 if (action === 'Prepare') return to.phase === 'rejected' ? 'refuse changed inputs' : 'prepare local startup';
 if (action === 'CheckLaunch') return to.phase === 'rejected' ? 'refuse changed inputs' : 'check startup inputs';
 if (action === 'Start') return 'start from the execution copy';
 if (action === 'CorruptSnapshot') return 'execution copy is corrupted';
 if (action === 'CheckWorkerInputs') return to.phase === 'rejected' ? 'refuse a corrupted execution copy' : 'verify the worker copy';
 if (action === 'WorkerStart') return 'start from the worker copy';
 if (action === 'EditInputs') return from.version !== from.baseline ? null : 'working files change';
 return 'finish';
};
