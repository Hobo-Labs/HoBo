export const title = 'Fence a rollback execution claim';
export const state = (v) => {
  if (v.protocol === 'legacy') return 'Legacy claim requires reconciliation';
  if (v.effects.length > 0) return 'Rollback effect started';
  if (v.owner !== 'none' && v.phase[v.owner] === 'lost') return 'Claim response lost and needs reconciliation';
  if (v.owner !== 'none' && v.reply[v.owner] !== v.owner) return 'Claim response mismatched';
  if (v.owner !== 'none') return 'Execution token recorded';
  return 'Waiting for execution claim';
};
export const step = (action) => ({ Claim: 'claim token', Compete: 'observe another token', CommitLost: 'claim response lost', FailBefore: 'append failed', ForgedAck: 'unverifiable response', WrongAck: 'mismatched response', Effect: 'start rollback effect', Done: 'wait' })[action] ?? action;
