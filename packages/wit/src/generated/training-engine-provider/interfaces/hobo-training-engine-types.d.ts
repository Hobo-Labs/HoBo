/** @module Interface hobo:training-engine/types@0.1.0 **/
/**
 * # Variants
 *
 * ## `"unspecified"`
 *
 * ## `"llm"`
 *
 * ## `"chain"`
 *
 * ## `"tool"`
 *
 * ## `"retriever"`
 *
 * ## `"reranker"`
 *
 * ## `"embedding"`
 *
 * ## `"agent"`
 *
 * ## `"guardrail"`
 *
 * ## `"evaluator"`
 *
 * ## `"prompt"`
 */
export type OpenInferenceSpanKind = 'unspecified' | 'llm' | 'chain' | 'tool' | 'retriever' | 'reranker' | 'embedding' | 'agent' | 'guardrail' | 'evaluator' | 'prompt';
export interface GeneratedRegionRef {
  regionId: string,
  artifactRef: string,
  startOffset: number,
  endOffset: number,
  owner: string,
}
export interface AgentRef {
  id: string,
  principalRef: string,
}
export interface RunRef {
  id: string,
  tenantId: string,
  bindle: string,
  agent: AgentRef,
}
export interface SubjectRef {
  method: string,
  contractRef: string,
  generatedRegion: GeneratedRegionRef,
}
export interface Span {
  id: string,
  parentId?: string,
  kind: OpenInferenceSpanKind,
  name: string,
  startTime: string,
  endTime: string,
  attributesJson: string,
  inputsJson: string,
  outputsJson: string,
}
export interface Reward {
  source: string,
  rubricRef: string,
  score: number,
}
export interface Trajectory {
  id: string,
  traceparent: string,
  run: RunRef,
  subject: SubjectRef,
  spans: Array<Span>,
  payloadsJson: string,
  reward: Reward,
}
export interface Rubric {
  id: string,
  objective: string,
}
export interface ContractRef {
  ref: string,
  method: string,
  allowedRegionId: string,
}
export interface OptimizeRequest {
  requestId: string,
  generatedRegion: GeneratedRegionRef,
  trajectories: Array<Trajectory>,
  rubric: Rubric,
  contract: ContractRef,
}
export interface CandidateEdit {
  startOffset: number,
  endOffset: number,
  replacement: string,
}
/**
 * ADR-0048: region-scoped source rewrite.
 */
export interface CandidatePatch {
  region: GeneratedRegionRef,
  edits: Array<CandidateEdit>,
}
/**
 * ADR-0125: the serialized-optimized-program candidate form, applied at
 * component instantiation. program-json carries the platform-normalized
 * TrainingArtifactProgram.
 */
export interface TrainingArtifact {
  engineId: string,
  engineVersion: string,
  methodRef: string,
  programJson: string,
}
export type CandidateBody = CandidateBodyPatch | CandidateBodyArtifact;
export interface CandidateBodyPatch {
  tag: 'patch',
  val: CandidatePatch,
}
export interface CandidateBodyArtifact {
  tag: 'artifact',
  val: TrainingArtifact,
}
export interface CandidateProvenance {
  trajectoryHashes: Array<string>,
  rubricRef: string,
  contractRef: string,
}
export interface Candidate {
  id: string,
  engineId: string,
  provenance: CandidateProvenance,
  body: CandidateBody,
}
export interface TrainingError {
  code: string,
  message: string,
}
