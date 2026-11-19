#!/usr/bin/env node
import { deployOpenSaasTemporaryClient } from "./deploy-opensaas-temporary-lib.mts";

const json = process.argv.includes("--json");
const root =
	process.env.HOBO_OPENSAAS_WASP_ROOT?.trim() || "examples/wasp-opensaas/app";
try {
	const result = await deployOpenSaasTemporaryClient({
		root,
		skipBuild: process.env.HOBO_OPENSAAS_SKIP_BUILD === "1",
	});
	if (json) {
		console.log(JSON.stringify(result));
	} else {
		console.log(JSON.stringify(result, null, 2));
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (json) {
		console.log(JSON.stringify({ ok: false, error: message }));
	} else {
		console.error(message);
	}
	process.exitCode = 1;
}
