/** @module Interface hobo:runtime/command@0.1.0 **/
export function execute(typeName: string, input: Bytes, actor: ActorKey, idempotencyKey: string): bigint;
export function emit(event: Event): bigint;
export type ActorKey = import('./hobo-runtime-types.js').ActorKey;
export type Bytes = import('./hobo-runtime-types.js').Bytes;
export type Event = import('./hobo-runtime-types.js').Event;
export type RuntimeError = import('./hobo-runtime-types.js').RuntimeError;
