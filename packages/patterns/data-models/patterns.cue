// CUE constraints for every protobuf type in patterns.proto.

package patterns

#PatternKind:
	"PATTERN_KIND_UNSPECIFIED" |
	"PATTERN_KIND_CONCEPT" |
	"PATTERN_KIND_STARTER" |
	"PATTERN_KIND_GUIDANCE" |
	"PATTERN_KIND_TRANSFORM"

#PatternMaturity:
	"PATTERN_MATURITY_UNSPECIFIED" |
	"PATTERN_MATURITY_STABLE" |
	"PATTERN_MATURITY_PARTIAL" |
	"PATTERN_MATURITY_EXPERIMENTAL" |
	"PATTERN_MATURITY_LEGACY" |
	"PATTERN_MATURITY_DEPRECATED"

#RenderingKind:
	"RENDERING_KIND_UNSPECIFIED" |
	"RENDERING_KIND_SNIPPET" |
	"RENDERING_KIND_FILE" |
	"RENDERING_KIND_PROJECT" |
	"RENDERING_KIND_MARKDOWN" |
	"RENDERING_KIND_VSCODE_SNIPPET" |
	"RENDERING_KIND_STRUCTURAL_EFFECTS"

#ParameterKind:
	"PARAMETER_KIND_UNSPECIFIED" |
	"PARAMETER_KIND_TYPESCRIPT_IDENTIFIER" |
	"PARAMETER_KIND_TYPESCRIPT_STRING" |
	"PARAMETER_KIND_JSON_STRING" |
	"PARAMETER_KIND_PACKAGE_NAME" |
	"PARAMETER_KIND_RELATIVE_PATH" |
	"PARAMETER_KIND_PROFILE_ID" |
	"PARAMETER_KIND_RESOURCE_NAME" |
	"PARAMETER_KIND_INTEGER" |
	"PARAMETER_KIND_BOOLEAN" |
	"PARAMETER_KIND_LITERAL_CHOICE"

#SearchChannel:
	"SEARCH_CHANNEL_UNSPECIFIED" |
	"SEARCH_CHANNEL_EXACT_ID" |
	"SEARCH_CHANNEL_EXACT_ALIAS" |
	"SEARCH_CHANNEL_EXACT_SYMBOL" |
	"SEARCH_CHANNEL_SYMBOLIC_FEATURE" |
	"SEARCH_CHANNEL_FTS5" |
	"SEARCH_CHANNEL_ONTOLOGY_VECTOR" |
	"SEARCH_CHANNEL_OPTIONAL_DENSE" |
	"SEARCH_CHANNEL_COMPATIBILITY" |
	"SEARCH_CHANNEL_COMPOSITION"

#SearchDecision:
	"SEARCH_DECISION_UNSPECIFIED" |
	"SEARCH_DECISION_SELECTED" |
	"SEARCH_DECISION_CANDIDATES" |
	"SEARCH_DECISION_ABSTAINED" |
	"SEARCH_DECISION_NOT_FOUND" |
	"SEARCH_DECISION_INCOMPATIBLE"

#WritePolicy:
	"WRITE_POLICY_UNSPECIFIED" |
	"WRITE_POLICY_STDOUT_ONLY" |
	"WRITE_POLICY_CREATE_ONLY" |
	"WRITE_POLICY_FAIL_IF_EXISTS" |
	"WRITE_POLICY_MERGE_GITIGNORE" |
	"WRITE_POLICY_STRUCTURAL_EDIT" |
	"WRITE_POLICY_REPLACE_GENERATED_REGION"

#ValidationKind:
	"VALIDATION_KIND_UNSPECIFIED" |
	"VALIDATION_KIND_SCHEMA" |
	"VALIDATION_KIND_CUE" |
	"VALIDATION_KIND_RENDER" |
	"VALIDATION_KIND_PARSE" |
	"VALIDATION_KIND_FORMAT" |
	"VALIDATION_KIND_TYPECHECK" |
	"VALIDATION_KIND_SEMANTIC" |
	"VALIDATION_KIND_PACT" |
	"VALIDATION_KIND_PACKAGE" |
	"VALIDATION_KIND_SECURITY" |
	"VALIDATION_KIND_IDEMPOTENCE"

#EffectKind:
	"EFFECT_KIND_UNSPECIFIED" |
	"EFFECT_KIND_ENSURE_IMPORT" |
	"EFFECT_KIND_DECLARE_RESOURCE" |
	"EFFECT_KIND_DECLARE_CONNECTOR" |
	"EFFECT_KIND_ADD_DEPENDENCY" |
	"EFFECT_KIND_ADD_ALLOWANCE" |
	"EFFECT_KIND_ADD_ANNOTATION" |
	"EFFECT_KIND_ADD_RETURN_PROPERTY" |
	"EFFECT_KIND_CREATE_FILE" |
	"EFFECT_KIND_CREATE_PROJECT_FILE" |
	"EFFECT_KIND_EMIT_GUIDANCE"

#ReceiptStatus:
	"RECEIPT_STATUS_UNSPECIFIED" |
	"RECEIPT_STATUS_ACCEPTED" |
	"RECEIPT_STATUS_REJECTED" |
	"RECEIPT_STATUS_AMBIGUOUS" |
	"RECEIPT_STATUS_FAILED"

#UnitInterval: number & >=0 & <=1

#OntologyFeature: {
	id:     string & !=""
	weight: number & >0
}

#PatternParameter: {
	name:              string & !=""
	kind:              #ParameterKind
	required:          bool
	defaultWire?:      string
	choices?: [...string]
	description?:      string
	constraint?:       string
	affectsPath:       bool
	displayInReceipt:  bool
}

#PatternProvenance: {
	sourcePath:   string & !=""
	sourceCommit: string
	sourceSymbol: string
	rationale:    string
}

#PatternRendering: {
	patternId:           string & !=""
	patternVersion:      int & >0
	renderingId:         string & !=""
	kind:                #RenderingKind
	language:            string
	targetContext:       string
	sourcePath:          string & !=""
	writePolicy:         #WritePolicy
	outputFiles?: [...string]
	requiredParameters?: [...string]
	contentDigest:       string
	effectIds?: [...string]
	isDefault:           bool
}

#StructuralEffect: {
	id:      string & !=""
	kind:    #EffectKind
	target:  string
	payload: string
}

#ValidationObligation: {
	kind:   #ValidationKind
	detail: string
}

#PatternManifest: {
	id:            string & !=""
	version:       int & >0
	kind:          #PatternKind
	maturity:      #PatternMaturity
	title:         string & !=""
	intent:        string & !=""
	description:   string
	aliases?: [...string]
	apiSymbols?: [...string]
	features?: [...#OntologyFeature]
	contexts?: [...string]
	languages?: [...string]
	outputKinds?: [...#RenderingKind]
	parameters?: [...#PatternParameter]
	provides?: [...string]
	requires?: [...string]
	conflicts?: [...string]
	effects?: [...#StructuralEffect]
	renderings: [...#PatternRendering] & [_, ...]
	packageConstraints?: [...string]
	provenance: [...#PatternProvenance] & [_, ...]
	limitations?: [...string]
	validations?: [...#ValidationObligation]
	replacementId?: string
	legacyAliases?: [...string]
	contentDigest:  string
}

#PatternSearchRequest: {
	query?:              string
	exactId?:            string
	kindFilter?: [...#PatternKind]
	maturityFilter?: [...#PatternMaturity]
	languageFilter?:     string
	contextFilter?:      string
	renderingFilter?:    #RenderingKind
	maxResults:          int & >0
	allowDense:          bool
	autoSelect:          bool
	allowComposition:    bool
}

#ChannelScore: {
	channel: #SearchChannel
	rank:    int & >=0
	score:   number
}

#PatternSearchCandidate: {
	patternId:      string & !=""
	patternVersion: int & >0
	fusedRank:      int & >=0
	channels?: [...#ChannelScore]
	explanation:    string
	selectable:     bool
}

#PatternSearchReceipt: {
	requestDigest:    string & !=""
	catalogDigest:    string & !=""
	vocabularyDigest: string & !=""
	encoderId:        string & !=""
	decision:         #SearchDecision
	llmCalls:         0
	llmInputTokens:   0
	llmOutputTokens:  0
	status:           #ReceiptStatus
}

#VirtualFile: {
	path:     string & !=""
	digest:   string
	contents: string
}

#PatternRenderReceipt: {
	patternId:        string & !=""
	patternVersion:   int & >0
	renderingId:      string & !=""
	llmCalls:         0
	llmInputTokens:   0
	llmOutputTokens:  0
	status:           #ReceiptStatus
}

#PatternCompositionReceipt: {
	llmCalls:        0
	llmInputTokens:  0
	llmOutputTokens: 0
	status:          #ReceiptStatus
}

#PatternApplicationPlan: {
	isolationRunId:    string
	sourceRoot:        string
	targetPath:        string
	promotionRequired: bool
}

#PatternApplicationReceipt: {
	isolationRunId:    string
	idempotent:        bool
	promotionRequired: bool
	llmCalls:          0
	llmInputTokens:    0
	llmOutputTokens:   0
	status:            #ReceiptStatus
}

#PatternEvalCase: {
	id:            string & !=""
	query:         string
	expectAbstain: bool
}

#PatternEvalReport: {
	cases:            int & >=0
	recallAt1:        #UnitInterval
	recallAt3:        #UnitInterval
	abstainPrecision: #UnitInterval
	elapsedMs:        int & >=0
}
