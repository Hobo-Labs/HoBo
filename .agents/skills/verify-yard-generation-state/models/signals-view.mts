export const title = 'Validate and capture a provider signal batch';
export const state = v => ({
  received: 'Provider signals received',
  refused: v.partial ? 'Batch refused after a partial fold' : 'Invalid batch refused',
  pending: 'Validated batch captured',
  folded: v.rawMismatch || v.invalidNormalized || v.brokerDecision || v.foreignSeq ? 'Invalid signal folded' : 'Validated signals folded',
})[v.phase];
export const step = (action, from, to) => ({
  Validate: to.phase === 'refused' ? 'refuse an invalid batch' : 'capture the validated batch',
  Append: to.rawMismatch || to.invalidNormalized || to.brokerDecision || to.foreignSeq ? 'fold invalid signal data' : 'fold the captured signals',
  Done: 'finish',
})[action] ?? null;
