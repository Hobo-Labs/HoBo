/** @module Interface wasi:websocket/types@0.0.1-draft **/
export type InputStream = import('./wasi-io-streams.js').InputStream;
export type OutputStream = import('./wasi-io-streams.js').OutputStream;
export type Pollable = import('./wasi-io-poll.js').Pollable;
export type Message = MessageText | MessageBinary;
export interface MessageText {
  tag: 'text',
  val: string,
}
export interface MessageBinary {
  tag: 'binary',
  val: Uint8Array,
}
export interface CloseInfo {
  code: number,
  reason?: string,
}
/**
 * # Variants
 *
 * ## `"connecting"`
 *
 * ## `"open"`
 *
 * ## `"closing"`
 *
 * ## `"closed"`
 */
export type State = 'connecting' | 'open' | 'closing' | 'closed';
/**
 * # Variants
 *
 * ## `"invalid-url"`
 *
 * ## `"refused"`
 *
 * ## `"protocol-error"`
 *
 * ## `"closed"`
 *
 * ## `"provider-error"`
 */
export type ErrorCode = 'invalid-url' | 'refused' | 'protocol-error' | 'closed' | 'provider-error';
export interface AcceptRequest {
  path: string,
  headers: Array<[string, string]>,
  body: InputStream,
}
export interface AcceptResponse {
  connection: Connection,
  response: OutputStream,
}
export interface ConnectOptions {
  headers: Array<[string, string]>,
  subprotocols: Array<string>,
}

export class Connection {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  id(): string;
  state(): State;
  poll(): Pollable;
  readMessage(): Message | undefined;
  writeMessage(msg: Message): void;
  close(info: CloseInfo): void;
}
