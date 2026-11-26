/** @module Interface hobo:runtime/agent@0.1.0 **/
export function run(name: string, messages: Array<AgentMessage>): Bytes;
export function tool(call: ToolCall): Bytes;
export function token(request: TokenRequest): TokenHandle;
export type AgentMessage = import('./hobo-runtime-types.js').AgentMessage;
export type Bytes = import('./hobo-runtime-types.js').Bytes;
export type RuntimeError = import('./hobo-runtime-types.js').RuntimeError;
export type TokenHandle = import('./hobo-runtime-types.js').TokenHandle;
export type TokenRequest = import('./hobo-runtime-types.js').TokenRequest;
export type ToolCall = import('./hobo-runtime-types.js').ToolCall;
