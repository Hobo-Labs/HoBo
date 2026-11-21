export const title = 'Resume a workflow using its saved input';
export const state = v => ({checking:'Checking the saved run',running:v.effects ? 'Workflow resumed' : 'Saved run accepted',rejected:'Resume refused'})[v.phase];
export const step = action => ({Resume:'check journal and input',RunEffect:'continue the workflow',Done:'finish'})[action] ?? action;
