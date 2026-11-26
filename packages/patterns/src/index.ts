export {
	EffectKind,
	ParameterKind,
	type PatternApplicationPlan,
	type PatternApplicationReceipt,
	type PatternCompositionReceipt,
	type PatternEvalReport,
	PatternKind,
	type PatternManifest,
	PatternMaturity,
	type PatternRenderReceipt,
	type PatternSearchReceipt,
	ReceiptStatus,
	RenderingKind,
	SearchChannel,
	SearchDecision,
} from "./_generated/patterns_pb.js";
export {
	defaultAtomsRoot,
	defaultCatalogRoot,
	loadPatternCatalog,
	type PatternCatalog,
	readRenderingBody,
} from "./catalog.js";
export { composePatterns } from "./compose.js";
export {
	cosineSimilarity,
	decodeVectorBlob,
	digestBytes,
	type EncodedVector,
	encodeOntologyVector,
	encodePatternDocument,
	encodeVectorBlob,
} from "./encode.js";
export { type DenseEncoderPort, rejectModel2Vec } from "./model2vec-port.js";
export {
	canonicalJson,
	type ParsedApplicationRequest,
	type ParsedCompositionRequest,
	type ParsedRenderRequest,
	PatternParseError,
	parseApplicationRequest,
	parseCompositionRequest,
	parsePatternManifest,
	parsePatternQuery,
	parseRenderRequest,
} from "./parse.js";
export { fillTemplate, parseParams, renderPattern } from "./render.js";
export {
	compileSafeFtsQuery,
	explainPatternMatch,
	searchPatterns,
} from "./retrieve.js";
export {
	buildPatternIndex,
	defaultIndexPath,
	openPatternIndex,
	type PatternIndex,
	type PatternIndexBuildReceipt,
} from "./sqlite-index.js";
export {
	assertCatalogStarter,
	CLI_STARTER_ALIASES,
	type CliStarterAlias,
	catalogStarterId,
	catalogStarterProjectRoot,
	isCliStarterAlias,
	renderCliStarterFiles,
} from "./starters.js";
export {
	applyPatternPlan,
	planPatternApplication,
} from "./typescript-apply.js";
export {
	evaluatePatternRetrieval,
	parseEvalCases,
	validatePatternCatalog,
	validateRenderedPattern,
} from "./validate.js";
export {
	buildHoboVocabulary,
	type HoboVocabulary,
	normalizePatternQuery,
	ONTOLOGY_ENCODER_ID,
} from "./vocabulary.js";
export { buildVsCodeSnippets } from "./vscode-snippets.js";
