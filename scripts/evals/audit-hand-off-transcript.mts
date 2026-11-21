#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import {
	auditHandOff,
	parseClaudeTranscript,
} from "../../packages/hobo-ci/src/hand-off-audit.ts";

const args = process.argv.slice(2);
const ownerFormUnavailable = args.includes("--owner-form-unavailable");
const ownerFormPrivacyVerified = args.includes("--owner-form-privacy-verified");
const files = args.filter(
	(arg) =>
		arg !== "--owner-form-unavailable" &&
		arg !== "--owner-form-privacy-verified",
);
if (files.length === 0) {
	console.error(
		"usage: audit-hand-off-transcript [--owner-form-unavailable] [--owner-form-privacy-verified] <transcript.jsonl>...",
	);
	process.exit(2);
}
let failed = false;
const options = {
	ownerFormAvailable: !ownerFormUnavailable,
	ownerFormPrivacyVerified,
};
for (const file of files) {
	const findings = auditHandOff(
		parseClaudeTranscript(await readFile(file, "utf8")),
		options,
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
