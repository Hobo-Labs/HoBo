package runtime_code_mutation_pattern_adr

import "list"

#RuntimeCodeMutationPatternAdrGate: {
	issue:              "HOBO-700"
	pattern_path:       "docs/patterns/runtime-code-mutation-persistence.md"
	required_adr_link:  "../design/adr/03-data-plane.md#adr-0048"
	retargeted_links: [...string] & list.MinItems(5)
	state:              #RuntimeCodeMutationPatternAdrState
	errors:             [...string]
}

#RuntimeCodeMutationPatternAdrState: "LINKED" | "STALE"
