/** @module Interface hobo:evidence/evidence@0.1.0 **/
export function submit(item: EvidenceRecord): string;
export function beginArtifact(metadata: ArtifactMetadata): ArtifactWriter;
/**
 * # Variants
 *
 * ## `"status"`
 *
 * ## `"test"`
 *
 * ## `"feature"`
 *
 * ## `"decision"`
 *
 * ## `"diagram"`
 *
 * ## `"screenshot"`
 *
 * ## `"recording"`
 *
 * ## `"replay"`
 *
 * ## `"annotation"`
 *
 * ## `"note"`
 */
export type Kind = 'status' | 'test' | 'feature' | 'decision' | 'diagram' | 'screenshot' | 'recording' | 'replay' | 'annotation' | 'note';
export interface ArtifactMetadata {
  title: string,
  mediaType: string,
}
export interface ArtifactRef {
  id: string,
  mediaType: string,
  sha256: string,
  size: bigint,
}
export interface EvidenceRecord {
  kind: Kind,
  title: string,
  summary: string,
  subject: string,
  artifactRefs: Array<string>,
  sourceRef?: string,
}

export class ArtifactWriter {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  write(chunk: Uint8Array): void;
  finish(): ArtifactRef;
}
