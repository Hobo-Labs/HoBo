export const title = 'Record a fuzz oracle event';
export const state = (v) => {
  if (v.phase === 'requested') return 'Event requested';
  if (v.phase === 'rejected') return 'Event rejected with history unchanged';
  if (v.kind === 'owned') return v.phase === 'replayed' ? 'Replay-owned event changed replay' : 'Replay-owned event recorded';
  if (!v.valid) return 'Invalid payload recorded';
  if (v.stored !== 0) return 'Stored event payload changed';
  if (v.phase === 'replayed' && (v.replayRevision !== v.revision || v.replayState !== 0)) return 'Replay differs from recorded history';
  return v.phase === 'replayed' ? 'History replayed' : 'Event recorded';
};
export const step = (action, _from, to) => action === 'Append' ? (to.phase === 'rejected' ? 'reject event' : 'record event') : ({ InputEdit: 'caller edits payload', ViewEdit: 'reader edits history view', Replay: 'replay history', Wait: 'wait' })[action] ?? action;
