export const title = 'Authorize local-process hosting';
export const state = v => {
 if (v.phase === 'policy') return 'Work awaits local-host authorization';
 if (v.phase === 'approved') return !v.derivedLocal || !v.declaredLocal ? 'Nonlocal requirements incorrectly approved' : !v.derivedDuring || !v.declaredDuring ? 'Changed requirements incorrectly approved' : 'Local requirements approved';
 if (v.phase === 'resolved') return !v.declaredLocal ? 'Placement omits a requested runtime' : v.host === 'local' ? 'Local-process placement resolved' : 'Different host incorrectly resolved';
 return v.derivedLocal && v.declaredLocal ? 'Changed requirements refused' : 'Nonlocal runtime refused';
};
export const step = (action, from, to) => {
 if (action === 'Authorize') return to.phase !== 'approved' ? 'refuse nonlocal or changed requirements' : !from.derivedLocal || !from.declaredLocal ? 'approve a nonlocal runtime' : !from.derivedDuring || !from.declaredDuring ? 'approve changed requirements' : 'approve current local requirements';
 if (action === 'Handoff') return to.phase === 'resolved' ? 'return the approved placement' : 'refuse changed requirements';
 return 'finish';
};
