export const title = 'Bind the embedded Camp request to the broker receipt';
export const state = v => ({
  received: 'Placement requested',
  captured: 'Camp request captured',
  sent: 'Camp request sent to broker',
  refused: 'Foreign Camp refused and identified',
  approved: 'Camp approved by broker',
  returned: 'Authorized Camp returned',
})[v.phase];
export const step = (action, from, to) => ({
  Capture: to.captured === 'unset' ? 'continue without capturing the Camp' : 'capture the requested Camp',
  Edit: 'caller changes its original options',
  Send: to.sent === from.initial ? 'send the requested Camp to the broker' : 'send a different Camp request to the broker',
  Broker: to.phase !== 'refused' ? 'approve the selected Camp' : to.returned === from.initial ? 'refuse and report the requested Camp' : 'refuse but report a different Camp',
  Return: to.returned === from.receipt ? 'return the approved Camp' : 'return a different Camp',
  Done: 'finish',
})[action] ?? null;
