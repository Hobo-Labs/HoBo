export const title = 'Approve the funded Yard quote';
export const state = v => v.phase === 'policy' ? 'Quote awaits policy proof' : v.phase === 'issued' ? 'Approved quote admitted' : 'Unbound approval refused';
export const step = (action, from, to) => action === 'Authorize' ? (to.phase === 'issued' ? 'approve this quote' : 'refuse mismatched or missing proof') : 'finish';
