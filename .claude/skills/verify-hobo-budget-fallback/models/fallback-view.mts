export const title = 'Honor a budget when falling back to local placement';
export const state = v => {
 if (v.phase === 'start') return 'Deployment is requested';
 if (v.phase === 'yard') return 'Yard evaluates the request';
 if (v.phase === 'fallback') return v.budgetRequired ? 'Budgeted fallback considered' : 'Local fallback considered';
 if (v.phase === 'preparing') return v.budgetRequired ? 'Budget now required before local start' : 'Local workload being prepared';
 if (v.phase === 'preview-pending') return v.budgetRequired ? 'Budget now required before preview' : 'Local preview being prepared';
 if (v.phase === 'rejected') return 'Budget requirement refuses the request';
 if (v.phase === 'yard-result') return 'Yard supplies its own result';
 if (v.phase === 'remote') return 'Remote placement continues';
 if (v.phase === 'local-start') return v.budgetRequired ? 'Local work starts without budget admission' : 'Local workload starts';
 return v.budgetRequired ? 'Local preview omits required budget admission' : 'Local preview is returned';
};
export const step = (action, from, to) => {
 if (action === 'Choose') return to.phase === 'rejected' ? 'require budget authority' : to.phase === 'yard' ? 'ask the Yard' : to.phase === 'remote' ? 'use remote placement' : 'consider local fallback';
 if (action === 'YardStub') return 'the Yard has no usable manifest';
 if (action === 'YardReturns') return 'use the Yard result';
 if (action === 'BudgetArrives') return 'a budget becomes required';
 if (action === 'BeginFallback') return to.phase === 'rejected' ? 'require budget authority' : from.preview ? 'prepare the preview' : 'prepare local work';
 if (action === 'Start') return to.phase === 'rejected' ? 'require budget authority' : 'start local work';
 if (action === 'ReturnPreview') return to.phase === 'rejected' ? 'require budget authority' : 'return the preview';
 return 'finish';
};
