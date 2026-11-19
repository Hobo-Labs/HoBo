/** @module Interface wasi:blobstore/blobstore@0.2.0 **/
export function get(name: string): Object | undefined;
export function put(object: Object, body: Uint8Array): void;
export { _delete as delete };
function _delete(name: string): void;
export interface Object {
  name: string,
  contentType: string,
  digest: string,
  size: bigint,
}
