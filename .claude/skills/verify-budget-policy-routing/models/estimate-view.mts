export const title = 'Choose an affordable provider for the all-in estimate';
export const state = v => ({ready:'Dispatch requested',selected:'Affordable provider selected',reserved:'Full exposure held',replayed:'Same decision replayed',denied:'No provider affordable'})[v.phase];
export const step = action => ({Select:'compare estimate with budgets',Reserve:'reserve full exposure',Replay:'replay original inputs',Done:'finish'})[action] ?? action;
