export const title = 'Carry complete placement work across the wire';
export const state = v => ({
  binary: 'Placement request received',
  unknown: 'Wire fields under review',
  version: 'Wire fields under review',
  envelope: 'Work snapshot under review',
  amount: 'Work snapshot under review',
  selection: 'Work snapshot under review',
  identity: 'Work snapshot under review',
  'digest-format': 'Request digest under review',
  compare: 'Request digest under review',
  refused: 'Placement request refused',
  accepted: 'Placement request accepted for authorization',
})[v.phase];
export const step = (action, from, to) => ({
  Decode: to.phase === 'refused' ? 'refuse unreadable bytes' : 'read the request',
  InspectUnknown: to.phase === 'refused' ? 'refuse unknown fields' : 'inspect the version',
  InspectVersion: to.phase === 'refused' ? 'refuse an unsupported version' : 'inspect the work snapshot',
  InspectEnvelope: to.phase === 'refused' ? 'refuse missing work' : 'inspect the amount',
  InspectAmount: to.phase === 'refused' ? 'refuse an invalid amount' : 'inspect the selection',
  InspectSelection: to.phase === 'refused' ? 'refuse an invalid selection' : 'inspect the identity',
  InspectIdentity: to.phase === 'refused' ? 'refuse a missing identity' : 'inspect the digest',
  InspectDigestFormat: to.phase === 'refused' ? 'refuse an invalid digest' : 'compare the work',
  Compare: to.phase === 'refused' ? 'refuse inconsistent work' : 'accept the request for authorization',
  Done: 'finish',
})[action] ?? null;
