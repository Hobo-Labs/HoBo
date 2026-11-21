#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
	createProviderRedactor,
	LONG_TOKEN_RUN_PROFILE,
} from "../../packages/provider-redaction/src/provider-redaction.js";

const [jsonPath, label, stderrPath = "", exitArg = "0"] = process.argv.slice(2);
if (jsonPath === undefined || label === undefined)
	throw new Error(
		"usage: relay-deploy-result-report.mts <json> <label> [stderr] [status]",
	);

const envelopeSchema = z.object({
	code: z.string().optional(),
	message: z.string().optional(),
});
const envelope = (() => {
	try {
		return envelopeSchema.parse(JSON.parse(readFileSync(jsonPath, "utf8")));
	} catch {
		return undefined;
	}
})();
const exitCode = Number.parseInt(exitArg, 10);
const code =
	envelope?.code ??
	(envelope === undefined ? "HOBO_CI_DEPLOY_NO_ENVELOPE" : "HOBO_OK");
const message =
	envelope?.message ??
	(envelope === undefined ? "command did not emit a valid JSON envelope" : "");
const redact = createProviderRedactor(LONG_TOKEN_RUN_PROFILE);
console.log(`${label}: ${code}: ${redact(message, 4096)}`);
const stderr =
	stderrPath !== "" && existsSync(stderrPath)
		? readFileSync(stderrPath, "utf8")
		: "";
if (stderr !== "") console.log(redact(stderr, 4096));
process.exitCode =
	Number.isFinite(exitCode) && (envelope !== undefined || exitCode !== 0)
		? exitCode
		: 1;
