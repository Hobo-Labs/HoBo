package hobo

#MappingStyleKind: "whole-app" | "per-tier" | "per-binding"

MappingStyleKind: #MappingStyleKind

#PlannerResolutionRecord: {
	issue:            string
	mappingStyle:     #MappingStyleKind
	resolvedProvider: string
	rationale:        [...string]
}

PlannerResolutionRecord: #PlannerResolutionRecord
