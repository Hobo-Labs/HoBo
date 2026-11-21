export const title = 'Commit and recheck a strict runner start';
export const state = v => ({received:'Start request received',lookup:'Checking GitHub assignment',binding:'Binding job to slot',recheck:'Rechecking assignment',claimread:'Rechecking stored claim',rejected:'Request rejected',uncertain:'No receipt; reconcile',issued:'Receipt issued'})[v.phase];
export const step = action => ({Authenticate:'verify slot credential',Lookup:'check assignment',Bind:'commit binding',Recheck:'recheck assignment',CheckClaim:'recheck stored claim',Done:'finish'})[action] ?? action;
