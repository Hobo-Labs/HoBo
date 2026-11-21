export const title = 'Check a shared budget policy';
export const state = v => ({checking:'Checking policy',denied:'Request denied',feasible:'Policy allows the request','plan-needs-proof':'Plan feasible; native bound still needed'})[v.phase];
export const step = (action, from, to) => action === 'Evaluate' ? ({denied:'scope, window, budget, evidence or metric fails',feasible:'all applicable checks pass','plan-needs-proof':'plan requires native evidence before admission'})[to.phase] : action;
