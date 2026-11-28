export const title = 'Require a matching strict-start receipt';
export const state = v => ({ready:'Hook invoked',awaiting:'Waiting for receipt',authorized:'Workflow may start',rejected:'Workflow blocked'})[v.phase];
export const step = action => ({CheckContext:'check runner context',CheckReceipt:'validate status and receipt',Done:'finish'})[action] ?? action;
