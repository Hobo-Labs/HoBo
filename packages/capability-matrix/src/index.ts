export {
	CANDIDATE_BUCKETS,
	CANDIDATE_UNAVAILABILITY_CODES,
	type CandidateBucket,
	type CandidateUnavailability,
	type CandidateUnavailabilityCode,
	type CapabilityMatrixCandidate,
	classifyCandidateBucket,
	compareCandidates,
	unavailabilityForEvidenceState,
} from "./candidate.js";

export {
	capabilityMatrixDigest,
	capabilityMatrixDigestBody,
} from "./digest.js";
export {
	type CapabilityMatrixInput,
	generateCapabilityMatrix,
	type RegisteredDefinition,
} from "./generate.js";
export {
	CAPABILITY_MATRIX_CELL_COUNT,
	CAPABILITY_MATRIX_COORDINATES,
	type CapabilityMatrixCellKey,
	type CapabilityMatrixCoordinate,
	cellKey,
	coordinateIndex,
} from "./grid.js";

export {
	availableCandidates,
	CAPABILITY_MATRIX_SCHEMA_VERSION,
	type CapabilityMatrix,
	type CapabilityMatrixBucket,
	type CapabilityMatrixBuckets,
	type CapabilityMatrixCell,
	type CapabilityMatrixExclusion,
	COVERAGE_VERDICTS,
	type CoverageVerdict,
	cellDefinitionIds,
	deriveCoverageVerdict,
	EMPTY_BUCKET,
	EMPTY_BUCKETS,
	MATRIX_EXCLUSION_CODES,
	type MatrixExclusionCode,
} from "./matrix.js";

export {
	CAPABILITY_MATRIX_ERROR_CODES,
	type CapabilityMatrixDocument,
	CapabilityMatrixError,
	type CapabilityMatrixErrorCode,
	parseCapabilityMatrix,
	tryParseCapabilityMatrix,
} from "./parse.js";

export { renderCapabilityMatrixMarkdown } from "./render.js";

export {
	blockingFindings,
	type CapabilityMatrixFinding,
	type CapabilityMatrixValidation,
	type CapabilityMatrixValidationOptions,
	type CoverageSummaryEntry,
	MATRIX_FINDING_CODES,
	MATRIX_FINDING_SEVERITIES,
	type MatrixFindingCode,
	type MatrixFindingSeverity,
	validateCapabilityMatrix,
} from "./validate.js";
