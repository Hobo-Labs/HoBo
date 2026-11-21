/** @module Interface wasi:keyvalue/store@0.2.0 **/
export function get(key: string): Uint8Array | undefined;
export function set(entry: Entry): void;
export { _delete as delete };
function _delete(key: string): void;
export function exists(key: string): boolean;
export interface Entry {
  key: string,
  value: Uint8Array,
}
