export const title = 'Finish a workflow command scope';
export const state = v => {
 if (v.terminal) return 'Scope completed';
 if (v.scope === 'closed') return 'Scope aborted';
 if (v.phase === 'idle') return 'Scope open';
 if (v.phase === 'done') return 'Command finished';
 return 'Command outstanding';
};
export const step = action => ({
 Schedule:'schedule command',
 StartWrite:'start journal write',
 Acknowledge:'acknowledge journal write',
 StartEffect:'start effect',
 Finish:'finish command',
 Cancel:'cancel further work',
 Close:'finish scope',
 Done:'finish',
})[action] ?? action;
