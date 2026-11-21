#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
	createProviderRedactor,
	LONG_TOKEN_RUN_PROFILE,
} from "../../packages/provider-redaction/src/provider-redaction.js";
import { z } from "zod";

const [jsonPath, label] = process.argv.slice(2);
if (jsonPath === undefined || label === undefined)
	throw new Error("usage: relay-deploy-result-report.mts <json> <label>");

const envelope = z
	.object({ code: z.string().optional(), message: z.string().optional() })
	.parse(JSON.parse(readFileSync(jsonPath, "utf8")));
const code = envelope.code ?? "HOBO_OK";
const message = envelope.message ?? "";
const redact = createProviderRedactor(LONG_TOKEN_RUN_PROFILE);
console.log(`${label}: ${code}: ${redact(message, 4096)}`);
