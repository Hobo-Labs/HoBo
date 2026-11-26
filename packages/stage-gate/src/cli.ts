#!/usr/bin/env node
import { resolve } from "node:path";

import { defineReleaseGate, defineStageGateS0 } from "./definition.js";
import { parseStageGateRecord, serializeStageGateRecord } from "./parse.js";
import { runStageGate } from "./runner.js";
import type { RunStageGateOptions } from "./types.js";

function printUsage(): void {
	console.error("Usage: hobo-stage-gate run s0|release [--out <file>]");
}

async function main(): Promise<void> {
	const [, , command, gateId, ...rest] = process.argv;
	if (command !== "run" || (gateId !== "s0" && gateId !== "release")) {
		printUsage();
		process.exit(2);
	}

	let outFile: string | undefined;
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index];
		if (arg === "--out") {
			const next = rest[index + 1];
			if (!next) {
				console.error("--out requires a file path");
				process.exit(2);
			}
			outFile = resolve(next);
			index += 1;
		}
	}

	const definition =
		gateId === "release" ? defineReleaseGate() : defineStageGateS0();
	let options: RunStageGateOptions = { cwd: process.cwd() };
	if (outFile) {
		options = { ...options, outFile };
	}
	if (process.env.GITHUB_RUN_URL) {
		options = { ...options, ciRunUrl: process.env.GITHUB_RUN_URL };
	}
	const result = await runStageGate(definition, options);

	try {
		parseStageGateRecord(serializeStageGateRecord(result.record));
	} catch (error) {
		console.error(error);
		process.exit(1);
	}

	process.exit(result.exitCode);
}

main().catch((cause: unknown) => {
	console.error(cause);
	process.exit(1);
});
