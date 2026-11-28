export const title = 'Upgrade quota fencing without releasing uncertain work';
export const state = v => {
 const faults=[];
 if(v.wrongMutated) faults.push('wrong scope changed the store');
 if(v.migrated && !v.fenced) faults.push('legacy claim not fenced');
 if(v.oldWriteAfter) faults.push('old writer changed claims');
 const base=v.migrated ? 'Existing claims fenced; old writers refused' : 'Legacy quota store';
 return faults.length ? `${base}: ${faults.join(', ')}` : base;
};
export const step = (action,from,to) => ({WrongScope:to.wrongMutated?'wrong scope changes the store':'refuse a different scope',Upgrade:'fence existing claims and require the new protocol',OldWrite:to.oldWriteAfter?'old writer changes claims':'old writer cannot change upgraded claims',Done:'finish'})[action] ?? null;
