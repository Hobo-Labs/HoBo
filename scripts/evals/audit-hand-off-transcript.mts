#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import {
	auditHandOff,
	DEFAULT_HAND_OFF_AUDIT_OPTIONS,
	parseClaudeTranscript,
} from "../../packages/hobo-ci/src/hand-off-audit.ts";

const argv = process.argv.slice(2);
if (argv.some((arg) => arg.startsWith("-"))) {
	console.error(
		"usage: audit-hand-off-transcript <transcript.jsonl>... (no operator flags)",
	);
	process.exit(2);
}
const files = argv;
if (files.length === 0) {
	console.error("usage: audit-hand-off-transcript <transcript.jsonl>...");
	process.exit(2);
}
let failed = false;
for (const file of files) {
	const findings = auditHandOff(
		parseClaudeTranscript(await readFile(file, "utf8")),
		DEFAULT_HAND_OFF_AUDIT_OPTIONS,
	);
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
