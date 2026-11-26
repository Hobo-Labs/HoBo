/** @module Interface wasi:websocket/incoming-handler@0.0.1-draft **/
export function handle(request: AcceptRequest): AcceptResponse;
export type AcceptRequest = import('./wasi-websocket-types.js').AcceptRequest;
export type AcceptResponse = import('./wasi-websocket-types.js').AcceptResponse;
export type ErrorCode = import('./wasi-websocket-types.js').ErrorCode;
