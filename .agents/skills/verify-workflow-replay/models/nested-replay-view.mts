export const title = 'Replay a recorded parent step';
export const state = v => {
 if (v.replay === 'accepted') return 'Recorded parent reused';
 if (v.replay === 'rejected') return 'Unproven child refused';
 if (v.parent === 'closed') return 'Parent recorded';
 return v.child === 'none' ? 'Parent running' : 'Child scheduled';
};
export const step = action => ({
 ScheduleStep:'schedule child step',
 ScheduleSleep:'schedule child sleep',
 FinishChild:'record child outcome',
 CloseParent:'record parent outcome',
 Replay:'check child evidence',
 Done:'finish',
})[action] ?? action;
