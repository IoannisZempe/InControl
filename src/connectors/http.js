/**
 * Shared HTTP headers for connectors. Local connectors (loopback) don't need a token;
 * set INCONTROL_TOKEN when the agent runs on a different machine than the hub.
 */
export function hubHeaders(json = true) {
  const headers = {};
  if (json) headers['Content-Type'] = 'application/json';
  if (process.env.INCONTROL_TOKEN) headers.Authorization = `Bearer ${process.env.INCONTROL_TOKEN}`;
  return headers;
}
