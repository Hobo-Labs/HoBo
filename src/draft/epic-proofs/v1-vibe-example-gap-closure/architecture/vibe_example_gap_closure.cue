package vibe_example_gap_closure

#VibeChildIssue: {
	id: =~"^HOBO-[0-9]+$"
	title: =~"^Vibe slice:"
	project: string
	phase: "M1" | "M2" | "M5"
	estimate: 3 | 5
	target_package_path: =~"^src/draft/exp-proofs/(dx|ux|cx|ax|api)/[a-z0-9-]+$"
	proof_note_path: =~"^docs/design/proofs/hobo-[0-9]+-[a-z0-9-]+/README\\.md$"
	artifact_slices: [...string] & {if len(artifact_slices) < 1 {_|_}}
	required_scenarios: [...string] & {if len(required_scenarios) < 5 {_|_}}
	proof_modes: [...string] & {if len(proof_modes) < 4 {_|_}}
	source_design_docs: [...string] & {if len(source_design_docs) < 1 {_|_}}
	scope_out: [...string] & {if len(scope_out) < 6 {_|_}}
}

#VibeDxSliceIssue: {
	id: =~"^HOBO-[0-9]+$"
	parent_id: "HOBO-566"
	project: "CLI, MCP & Developer Experience"
	phase: "M1" | "M2"
	estimate: 3 | 5 | 8
	labels: [...string] & {if len(labels) < 4 {_|_}}
	target_package_path: =~"^src/draft/exp-proofs/(dx|ux|cx|ax|api)/[a-z0-9-]+$"
	proof_note_path: =~"^docs/design/proofs/[a-z0-9-]+/README\\.md$"
	blocked_by: [...string]
	blocks: [...string]
	lifecycle_coverage: [...string] & {if len(lifecycle_coverage) < 3 {_|_}}
	proof_modes: [...string] & {if len(proof_modes) < 4 {_|_}}
	scope_out: [...string] & {if len(scope_out) < 6 {_|_}}
}

#VibeDxBackboneGraph: {
	parent_issue: "HOBO-539"
	backbone_issue: "HOBO-566"
	backbone_labels: [...string] & {if len(backbone_labels) < 5 {_|_}}
	child_slices: [...#VibeDxSliceIssue] & {if len(child_slices) != 11 {_|_}}
	quickstart_consumer_ids: [...string] & {if len(quickstart_consumer_ids) < 25 {_|_}}
	terminal_error_consumer: "HOBO-558"
}

#VibeGapClosureBacklog: {
	parent_issue: "HOBO-539"
	parent_title: string
	child_issues: [...#VibeChildIssue] & {if len(child_issues) != 26 {_|_}}
	unblock_rule: string
	dx_backbone: #VibeDxBackboneGraph
}

#VibeGapClosureEvaluation: {
	ok: bool
	violations: [...string]
	unblock_outcome: string
}
