/** @module Interface hobo:wrpc-baseline/baseline@0.1.0 **/
export function smokeCall(startedAt: Datetime, link: WrpcLink, pins: Array<InterfacePin>): string;
export type Datetime = import('./wasi-clocks-wall-clock.js').Datetime;
export interface InterfacePin {
  id: string,
  version: string,
  stability: string,
  digest: string,
}
export interface WrpcLink {
  importInterface: string,
  providerExport: string,
  transport: string,
  deadlineMs: bigint,
}
