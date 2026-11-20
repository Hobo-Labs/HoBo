export const title = 'Route a CI job within its account budget';
export const state = v => ({queued:'Job waiting for a runner',offered:'Affordable runner selected',declined:'No runner fits the budget'})[v.phase];
export const step = action => ({ReserveOther:'another job reserves budget',CompleteOther:'another job completes',NewerObservation:'provider usage catches up',SameTimestamp:'usage arrives at the same instant',Offer:'route within budget',Decline:'budget cannot cover the runner'})[action] ?? action;
