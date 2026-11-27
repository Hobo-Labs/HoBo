export const title = 'Authorize a CI runner start';
export const state = v => ({none:'Awaiting a request or execution finished',new:'Start authorized',retry:'Start authorized',rejected:'Start rejected'})[v.receipt];
export const step = (action, from, to) => to.receipt === 'none' ? 'execution finishes' : to.receipt === 'rejected' ? 'request does not match or cannot start' : 'request commits or repeats the same authorization';
