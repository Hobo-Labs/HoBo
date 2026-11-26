/** @module Interface wasi:websocket/outgoing@0.0.1-draft **/
export function connect(url: string, opts: ConnectOptions): Connection;
export type ConnectOptions = import('./wasi-websocket-types.js').ConnectOptions;
export type Connection = import('./wasi-websocket-types.js').Connection;
export type ErrorCode = import('./wasi-websocket-types.js').ErrorCode;
