export const title = 'Rebuild and append budget signals';
export const state = v => {
  if (v.phase === 'pending') {
    if (v.record === 'exact') return 'Matching signal already recorded';
    if (v.record === 'foreign' || v.record === 'none') return 'No matching signal recorded';
    if (v.record === 'incomplete') return 'Financial facts are incomplete';
    if (v.record === 'orphan') return 'Recorded signal has no matching transition';
    return 'Journal contains a conflicting signal or key';
  }
  return ({suppressed:'Matching signal suppressed',refused:'Replay refused for reconciliation',emitted:'Signal ready to append',delivered:'Signal appended',deduped:'Signal lost to journal deduplication',ignored:'Orphaned signal left in journal'})[v.phase];
};
export const step = action => ({Suppress:'reuse recorded signal',Refuse:'require reconciliation',Emit:'prepare signal',IgnoreOrphan:'accept incomplete reconstruction',Append:'append signal',Done:'finish'})[action] ?? action;
