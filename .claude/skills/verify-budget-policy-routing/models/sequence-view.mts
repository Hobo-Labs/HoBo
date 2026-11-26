export const title = 'Protect budget-ledger sequence fences';
export const state = v => {
 if (v.phase === 'done') return v.operation === 'expire' ? 'Expiry completed' : v.operation === 'replay' ? 'Replay returned' : 'Mutation committed';
 if (v.phase === 'rejected') return 'Sequence exhausted';
 if (v.phase === 'advance' || v.phase === 'releasing') return 'Applying expiry';
 return 'Ledger operation requested';
};
export const step = action => ({Single:'mutate if space remains',Replay:'return prior result',PreflightExpiry:'check expiry batch',AdvanceTime:'advance ledger time',Release:'expire a pending hold',Finish:'finish expiry',Done:'finish'})[action] ?? action;
