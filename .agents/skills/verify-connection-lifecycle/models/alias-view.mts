export const title = 'Rebuild connection names';
export const state = (v) => {
 if (v.aliasTarget !== 'old') return 'Existing alias rebound';
 if (v.added && (v.candidateId === 'work' || ['work','old'].includes(v.candidateAlias))) return 'Connection names overlap';
 return ({loaded:'Replaying a connection creation', ignored:'Duplicate identity ignored', rejected:'Conflicting name rejected', accepted:'New connection added'})[v.phase];
};
export const step = (action, _from, to) => ({Attempt: ({ignored:'ignore duplicate identity', rejected:'reject conflicting name', accepted:'add connection'})[to.phase], Done:'finish'})[action] ?? action;
