export interface StreamProvider<Payload, Result> {
  readonly kind: 'stream';
  readonly id: string;
  readonly displayName: string;
  ingest(payload: Payload): Result;
}
