export const title = 'Claim a fresh workflow run ID';
export const state = v => {
  const ids = Object.values(v.issued);
  if (v.pc.a === 'claiming') return 'Claiming a run ID';
  if (v.pc.a === 'rejected') return 'Run ID already in use';
  if (v.pc.a === 'started') return 'New run claimed';
  return ids.length === 0 ? 'Ready for a new run' : 'Ready for another run';
};
export const step = action => ({Choose:'choose a run ID',Claim:'claim an unused journal',Collision:'reject an occupied journal',Restart:'start another run'})[action] ?? action;
