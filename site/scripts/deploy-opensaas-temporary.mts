#!/usr/bin/env node
/**
 * CLI: deploy real Wasp OpenSaaS client via Temporary Accounts.
 *   HOBO_OPENSAAS_SKIP_BUILD=1 HOBO_OPENSAAS_WASP_ROOT=examples/wasp-opensaas/app \
 *     pnpm exec tsx scripts/deploy-opensaas-temporary.mts --json
 */
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
