import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createPulumiAutomationAdapter,
	createPulumiCliAutomationEngine,
} from "../../packages/iac/iac-pulumi/src/index.js";
import {
	createHelloBindlePlan,
	realizeHelloBindle,
} from "../../packages/providers/provider-cloudflare/src/index.js";

// The credential-gated LIVE Pulumi lane: realize
// hello-bindle through the real provider lowering, then drive the pinned
// `pulumi` CLI engine through the same adapter the composed deploy path uses —
// preview, apply, refresh, destroy — against real Cloudflare. Teardown always
// runs; a failure after apply still attempts destroy before exiting non-zero.

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !token) {
	console.error(
		"CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID secrets are required for the live Pulumi lane.",
	);
	process.exit(1);
}

const { iac: program } = realizeHelloBindle(
	createHelloBindlePlan({
		id: `hello-bindle-live-${process.env.GITHUB_RUN_ID ?? "local"}`,
	}),
);

// HOBO_PULUMI_WORKDIR keeps the lane's programs and file:// state. Without it
// they go in a directory of this run's own, removed once teardown completes.
// When teardown fails it is kept, and named: its state is what the manual
// sweep needs.
const keptWorkDir = process.env.HOBO_PULUMI_WORKDIR;
const workDir = keptWorkDir ?? mkdtempSync(join(tmpdir(), "hobo-pulumi-live-"));
const engine = createPulumiCliAutomationEngine({
	workDir,
	env: process.env,
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
process.exit(failed ? 1 : 0);
