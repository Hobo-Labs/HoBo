/** @module Interface hobo:websocket/extension@0.1.0 **/
export function principal(conn: ConnId): PrincipalRef | undefined;
export function sendTo(conn: ConnId, msg: Message): void;
export function join(conn: ConnId, channel: string): void;
export function leave(conn: ConnId, channel: string): void;
export function broadcast(channel: string, msg: Message): void;
export type Message = import('./wasi-websocket-types.js').Message;
export type PrincipalRef = import('./hobo-auth-types.js').PrincipalRef;
export type ConnId = string;
