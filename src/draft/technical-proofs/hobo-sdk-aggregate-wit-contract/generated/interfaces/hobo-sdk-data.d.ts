/** @module Interface hobo:sdk/data@0.1.0 **/
export function query(query: DataQuery): Array<DataChange>;
export function append(change: DataChange): string;
export type DataChange = import('./hobo-sdk-types.js').DataChange;
export type DataQuery = import('./hobo-sdk-types.js').DataQuery;
export type SdkError = import('./hobo-sdk-types.js').SdkError;
