import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { withoutSecretEnv } from "../../packages/hobo-ci/src/secret-custody.js";
import {
	createPulumiAutomationAdapter,
	createPulumiCliAutomationEngine,
} from "../../packages/iac/iac-pulumi/src/index.js";
import {
	createHelloBindlePlan,
	realizeHelloBindle,
} from "../../packages/providers/provider-cloudflare/src/index.js";

export const LIVE_LANE_TOKEN_REF = "owner://CLOUDFLARE_API_TOKEN";

export async function runPulumiLiveLane(input: {
	readonly accountId: string;
	readonly apiToken: string;
}): Promise<boolean> {
	const { iac: program } = realizeHelloBindle(
		createHelloBindlePlan({
			id: `hello-bindle-live-${process.env.GITHUB_RUN_ID ?? "local"}`,
		}),
	);
	const keptWorkDir = process.env.HOBO_PULUMI_WORKDIR;
	const workDir =
		keptWorkDir ?? mkdtempSync(join(tmpdir(), "hobo-pulumi-live-"));
	const engine = createPulumiCliAutomationEngine({
		workDir,
		ephemeralState: keptWorkDir === undefined,
		env: {
			...withoutSecretEnv(process.env),
			CLOUDFLARE_ACCOUNT_ID: input.accountId,
			CLOUDFLARE_API_TOKEN: input.apiToken,
		},
	});
	const adapter = createPulumiAutomationAdapter({ engine });
	let failed = false;
	try {
		const preview = await adapter.preview(program);
		console.log(
			`preview: dirty=${preview.dirty} changes=${preview.changes.length}`,
		);
		const outputs = await adapter.apply(program);
		console.log(
			`apply: resources=${Object.keys(outputs.resources ?? {}).length}`,
		);
		const refresh = await adapter.refresh(program);
		console.log(`refresh: drifted=${refresh.drifted}`);
		if (refresh.drifted) {
			failed = true;
			console.error("drift immediately after apply — live lane failed");
		}
	} catch (error) {
		failed = true;
		console.error("live lane failed:", error);
	} finally {
		let tornDown = false;
		try {
			await adapter.destroy(program);
			console.log("destroy: complete");
			tornDown = true;
		} catch (error) {
			failed = true;
			console.error("teardown failed — manual sweep needed:", error);
		}
		if (keptWorkDir === undefined) {
			if (tornDown) rmSync(workDir, { recursive: true, force: true });
			else console.error(`the lane's Pulumi state is kept in ${workDir}`);
		}
	}
	return !failed;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	console.error(
		`The live Pulumi lane needs the Cloudflare API token ${LIVE_LANE_TOKEN_REF} from the owner's store session, and this script has none: it reads no credential from the environment. Run runPulumiLiveLane through HoBo with the owner's store session (HoBo MCP choose_secret_store).`,
	);
	process.exitCode = 1;
}
