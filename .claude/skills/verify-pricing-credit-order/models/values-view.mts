export const title = 'Validate and consume a pricing source';
export const state = v => ({received:'Financial source received',ready:'Source and charge accepted',rejected:'Quote rejected',applied:'Source debited'})[v.phase];
export const step = action => ({Validate:'check amount and basis',Consume:'debit or reject',Done:'finish'})[action] ?? action;
