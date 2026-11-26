/** @module Interface hobo:runtime/actor@0.1.0 **/
export function getState(key: ActorKey): StateEntry | undefined;
export function appendState(key: ActorKey, entry: StateEntry): bigint;
export function signal(key: ActorKey, msg: Message): bigint;
export type ActorKey = import('./hobo-runtime-types.js').ActorKey;
export type Message = import('./hobo-runtime-types.js').Message;
export type RuntimeError = import('./hobo-runtime-types.js').RuntimeError;
export type StateEntry = import('./hobo-runtime-types.js').StateEntry;
