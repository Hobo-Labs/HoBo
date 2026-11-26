/**
 * Every field RunReport v1 requires, and what `parseAiBddRunReport` does with
 * it: `read` (its value decides the evidence or a refusal) or
 * `ignored: <why>` (it must be present, since v1 requires it and the objects
 * the parser walks are closed, but any value of it leaves the evidence as it
 * is). A read object or array lists its own required fields below it; an
 * ignored one does not, because nothing beneath it is looked at.
 *
 * `test/acceptance-fields.test.ts` walks the schema copied into
 * `test/fixtures/ai-bdd/run-report.v1.schema.json` and fails on a required
 * field this table does not name, on an entry the schema does not require,
 * on a `read` field whose removal the parser accepts, on an `ignored` field
 * whose removal is refused for anything but its absence, and on an `ignored`
 * field whose value changes the evidence.
 */
const ID =
	"ignored: identifies the scenario or step; report_digest pins the whole report";

export const RUN_REPORT_FIELDS = {
	schemaVersion: "read",
	runId: "read",
	startedAt: "read",
	finishedAt: "ignored: the stage-gate record carries its own start and finish",
	options: "read",
	"options.frozen": "read",
	"options.strict":
		"ignored: healed scenarios are kept as their own count, so strictness can be applied to the evidence",
	"options.audit":
		"ignored: an audit adds checks; it does not decide whether the run replayed",
	"options.noAgent": "read",
	"options.updateRecordings": "read",
	"options.recordingsMode":
		"ignored: what a run may write; options.updateRecordings says whether it did",
	"options.workers": "ignored: parallelism, not outcome",
	scenarios: "read",
	"scenarios[].scenarioId": ID,
	"scenarios[].featureId": ID,
	"scenarios[].docUri": ID,
	"scenarios[].title": ID,
	"scenarios[].driver": ID,
	"scenarios[].status": "read",
	"scenarios[].mode":
		"ignored: with options.noAgent a scenario that needs the agent fails (ACT_NO_AGENT), which its status says",
	"scenarios[].review":
		"ignored: review state of the plan, not the outcome of the run",
	"scenarios[].steps": "read",
	"scenarios[].steps[].stepKey": ID,
	"scenarios[].steps[].kind": ID,
	"scenarios[].steps[].text": ID,
	"scenarios[].steps[].status":
		"ignored: a step's outcome is summed up by its scenario's status",
	"scenarios[].steps[].path":
		"ignored: options.noAgent and usage.byPurpose.act.modelCalls, both read, rule out the agent path",
	"scenarios[].steps[].determinism": "read",
	"scenarios[].steps[].fuzzyReasons": "read",
	"scenarios[].steps[].actions": "ignored: action count, not outcome",
	"scenarios[].steps[].usage": "read",
	"scenarios[].steps[].usage.modelCalls": "read",
	"scenarios[].steps[].usage.inputTokens": "read",
	"scenarios[].steps[].usage.outputTokens": "read",
	"scenarios[].steps[].durationMs": "read",
	"scenarios[].steps[].evidence":
		"ignored: evidence hashes are checked by `ai-bdd verify-run` (acceptance-evidence-intact)",
	"scenarios[].steps[].sources": ID,
	"scenarios[].recording":
		"ignored: options.updateRecordings, read, says whether recordings were rewritten",
	"scenarios[].usage": "read",
	"scenarios[].usage.modelCalls": "read",
	"scenarios[].usage.inputTokens": "read",
	"scenarios[].usage.outputTokens": "read",
	"scenarios[].durationMs": "read",
	totals: "read",
	"totals.passed": "read",
	"totals.failed": "read",
	"totals.healed": "read",
	"totals.blocked": "read",
	"totals.skipped": "read",
	"totals.inconclusive": "read",
	"totals.error": "read",
	usage: "read",
	"usage.modelCalls": "read",
	"usage.inputTokens": "read",
	"usage.outputTokens": "read",
	"usage.byPurpose": "read",
	"usage.byPurpose.extract": "read",
	"usage.byPurpose.extract.modelCalls": "read",
	"usage.byPurpose.extract.inputTokens": "read",
	"usage.byPurpose.extract.outputTokens": "read",
	"usage.byPurpose.act": "read",
	"usage.byPurpose.act.modelCalls": "read",
	"usage.byPurpose.act.inputTokens": "read",
	"usage.byPurpose.act.outputTokens": "read",
	"usage.byPurpose.checkgen": "read",
	"usage.byPurpose.checkgen.modelCalls": "read",
	"usage.byPurpose.checkgen.inputTokens": "read",
	"usage.byPurpose.checkgen.outputTokens": "read",
	"usage.byPurpose.judge": "read",
	"usage.byPurpose.judge.modelCalls": "read",
	"usage.byPurpose.judge.inputTokens": "read",
	"usage.byPurpose.judge.outputTokens": "read",
	coverage:
		"ignored: traceability of docs to scenarios, not the outcome of the replay",
	warnings:
		"ignored: diagnostics; a frozen run with a stale plan exits 4 and writes no report",
	exitCode: "read",
} as const satisfies Readonly<Record<string, string>>;
