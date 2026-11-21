#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import {
	auditHandOff,
	inferHandOffAuditOptions,
	parseClaudeTranscript,
} from "../../packages/hobo-ci/src/hand-off-audit.ts";

const files = process.argv.slice(2);
if (files.length === 0) {
	console.error("usage: audit-hand-off-transcript <transcript.jsonl>...");
	process.exit(2);
}
let failed = false;
for (const file of files) {
	const events = parseClaudeTranscript(await readFile(file, "utf8"));
	const findings = auditHandOff(events, inferHandOffAuditOptions(events));
	if (findings.length === 0) {
		console.log(`ok    ${file}`);
		continue;
	}
	failed = true;
	console.log(`fail  ${file}: ${findings.length} finding(s)`);
	for (const f of findings)
		console.log(`  line ${f.at}: ${f.ask} owed for ${f.line} — ${f.detail}`);
}
process.exit(failed ? 1 : 0);
