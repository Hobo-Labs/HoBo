#!/usr/bin/env node
// Audit agent transcripts of handed-off ceremonies (hobo ci|cd up --hand-off):
// every owner-facing line must get a structured ask (the HoBo MCP App's
// choice, the host's picker, the credential form), never a question in prose,
// and an interrupted ask must be asked again. Prints findings only, never
// transcript content. Exit 1 when any transcript has a finding.
//
//   pnpm run eval:hand-off-transcript <transcript.jsonl>...
import { readFile } from "node:fs/promises";

import {
	auditHandOff,
	parseClaudeTranscript,
} from "../../packages/hobo-ci/src/hand-off-audit.ts";

const files = process.argv.slice(2);
if (files.length === 0) {
	console.error("usage: audit-hand-off-transcript <transcript.jsonl>...");
	process.exit(2);
}
let failed = false;
for (const file of files) {
	const findings = auditHandOff(
		parseClaudeTranscript(await readFile(file, "utf8")),
	);
	if (findings.length === 0) {
		console.log(`ok    ${file}`);
		continue;
	}
	failed = true;
	console.log(
		`fail  ${file}: ${findings.length} turn(s) without the required ask`,
	);
	for (const f of findings)
		console.log(`  line ${f.at}: ${f.ask} owed for ${f.line} — ${f.detail}`);
}
process.exit(failed ? 1 : 0);
