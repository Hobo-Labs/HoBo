export const title = 'Resume a durable workflow after a crash';
export const state = v => ({idle:'Ready to run',running:v.journaled ? 'Restoring saved step' : 'Running a step', 'effect-returned':'Step ran; saving result',recorded:'Step saved',crashed:'Host stopped',done:'Step complete'})[v.phase];
export const step = action => ({Start:'start workflow',RunStep:'run step or reuse saved result',JournalResult:'save step result',Finish:'continue workflow',Crash:'host stops',Restart:'resume workflow',Done:'complete'})[action] ?? action;
