export const title = 'Respect exact Camp selection';
export const state = v => ({
  received: 'Camp request received',
  refused: 'Missing exact Camp ID refused',
  captured: 'Camp request accepted',
  selected: v.selected === 'requested' ? 'Requested Camp selected' : 'Default Camp selected',
  complete: v.quoted ? 'Camp work prepared for quote' : 'Camp work authorized',
})[v.phase];
export const step = (action, from, to) => ({
  Capture: to.phase === 'refused' ? 'refuse an exact request without an ID' : 'accept a valid request',
  Select: to.selected === 'requested' ? 'select the requested Camp [when an ID was supplied]' : 'select the default Camp [when no ID was supplied]',
  Complete: to.quoted ? 'prepare work for a quote' : 'authorize the selected Camp',
  Done: 'finish',
})[action] ?? null;
