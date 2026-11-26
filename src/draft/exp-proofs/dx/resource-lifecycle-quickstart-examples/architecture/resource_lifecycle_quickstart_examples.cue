package resource_lifecycle_quickstart_examples

import "list"

#QuickstartPhase: "define" | "collect" | "plan" | "deploy" | "inspect" | "manage" | "migrate" | "recover"
#QuickstartChannel: "sdk" | "cli" | "api" | "mcp"
#QuickstartProofMode: "reference-fixture" | "simulated" | "live" | "scope-out"
#QuickstartConsumer: "Docs Portal" | "Tutorials" | "Troubleshooting" | "Launch Site" | "Workspace UX" | "Plan/Diff" | "Dashboard"
#FixtureId: =~"^rlq-[a-z0-9-]+-v[0-9]+$"

#ResourceLifecycleQuickstartSnippet: {
	id:         =~"^[a-z0-9][a-z0-9-]+$"
	channel:    #QuickstartChannel
	text:       string & =~"\\S"
	fixtureId:  #FixtureId
	proofMode:  #QuickstartProofMode
	safeClaim:  string & =~"\\S"
}

#ResourceLifecycleQuickstartStep: {
	phase:  #QuickstartPhase
	title:  string & =~"\\S"
	intent: string & =~"\\S"
	snippets: #ResourceLifecycleQuickstartSnippets
}

#ResourceLifecycleQuickstartSnippets: {
	sdk: #ResourceLifecycleQuickstartSnippet & {channel: "sdk"}
	cli: #ResourceLifecycleQuickstartSnippet & {channel: "cli"}
	api: #ResourceLifecycleQuickstartSnippet & {channel: "api"}
	mcp: #ResourceLifecycleQuickstartSnippet & {channel: "mcp"}
}

#ResourceLifecycleQuickstartModeNote: {
	proofMode: #QuickstartProofMode
	meaning:   string & =~"\\S"
	docsLabel: string & =~"\\S"
}

#ResourceLifecycleQuickstartHandoff: {
	consumer:     #QuickstartConsumer
	use:          string & =~"\\S"
	fixtureIds:   [...#FixtureId] & list.MinItems(1)
	handoffNote:  string & =~"\\S"
	mustNotClaim: [...string] & list.MinItems(1)
}

#ResourceLifecycleQuickstartExamples: {
	issue:         "HOBO-577"
	phase:         "M2"
	targetPackage: "src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples"
	proofNote:     "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md"
	designRefs:    [...string] & list.MinItems(1)
	scopeOut: [
		"marketing copy not backed by transcripts",
		"customer promises",
		"live credentials",
		"production docs publication",
		"enterprise dashboard feature tours",
	]
	safeClaims: [...string] & list.MinItems(1)
	modeNotes:  [...#ResourceLifecycleQuickstartModeNote] & list.MinItems(4)
	steps:      [...#ResourceLifecycleQuickstartStep] & list.MinItems(8)
	handoffs:   [...#ResourceLifecycleQuickstartHandoff] & list.MinItems(7)
}
