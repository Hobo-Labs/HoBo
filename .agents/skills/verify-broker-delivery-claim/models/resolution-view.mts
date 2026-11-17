export const title = 'Resolve a request identity once';
export const state = v => v.receipts > 0 ? 'A receipt has been issued' : v.owner === 0 ? 'Request may be resolved' : 'Resolution in progress';
export const step = action => ({Start:'begin resolving',Reject:'refuse a repeated request',Issue:'issue the receipt',Abort:'refuse the resolution',Done:'finish'})[action] ?? action;
