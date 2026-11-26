/** @module Interface hobo:blob-events/blob-events@0.1.0 **/
export function on(filter: BlobEventFilter): BlobSubscription;
export function downloadUrl(request: PresignedUrlRequest): PresignedUrl;
export function uploadUrl(request: PresignedUrlRequest): PresignedUrl;
/**
 * # Variants
 *
 * ## `"invalid-argument"`
 *
 * ## `"not-found"`
 *
 * ## `"unauthorized"`
 *
 * ## `"provider-error"`
 */
export type BlobEventErrorCode = 'invalid-argument' | 'not-found' | 'unauthorized' | 'provider-error';
/**
 * # Variants
 *
 * ## `"created"`
 *
 * ## `"updated"`
 *
 * ## `"deleted"`
 */
export type BlobEventKind = 'created' | 'updated' | 'deleted';
export interface BlobEventError {
  code: BlobEventErrorCode,
  message?: string,
  retryable: boolean,
}
export interface BlobEventFilter {
  bucket: string,
  prefix?: string,
  events: Array<BlobEventKind>,
}
export interface BlobSubscription {
  subscriptionId: string,
  filter: BlobEventFilter,
}
export interface PresignedUrlRequest {
  bucket: string,
  key: string,
  expiresInMs: bigint,
  contentType?: string,
}
export interface Header {
  name: string,
  value: string,
}
export interface PresignedUrl {
  url: string,
  expiresAtMs: bigint,
  headers: Array<Header>,
}
