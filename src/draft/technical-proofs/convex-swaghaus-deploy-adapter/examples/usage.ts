import { strict as assert } from "node:assert";
import { convexImpedanceFindings } from "@hobo/provider-convex";

import {
	ConvexDeployParseError,
	parseDeployReceipt,
	parseImpedanceRecords,
	shipSwaghausConvexApp,
} from "../src/index.ts";

const workosEnv = {
	VITE_WORKOS_CLIENT_ID: "client_live",
	VITE_WORKOS_REDIRECT_URI: "https://swaghaus.example/callback",
	WORKOS_CLIENT_ID: "client_live",
};

// Fail-closed: an uncredentialed live ship is refused before the executor runs.
const refused = await shipSwaghausConvexApp({
	root: "examples/convex-swaghaus",
	deploymentName: "swaghaus",
	env: {},
	spawn: async () => {
		throw new Error("executor must not run without credentials");
	},
});
assert.equal(refused.phase, "refused");
if (refused.phase === "refused") {
	console.log(`refused missing=${refused.preflight.missing.join(",")}`);
}

// Explicit mock lane: allowed without credentials, but never claims to be live.
const mocked = await shipSwaghausConvexApp({
	root: "examples/convex-swaghaus",
	deploymentName: "swaghaus",
	mock: true,
	env: workosEnv,
});
assert.equal(mocked.phase, "deployed");
if (mocked.phase === "deployed") {
	console.log(
		`mock mode=${mocked.receipt.mode} mocked=${mocked.receipt.mocked} url=${mocked.receipt.deploymentUrl} live=${mocked.preflight.live}`,
	);
}

// Self-hosted lane through an injected runner: the URL is scraped from the
// convex CLI stdout, so it crosses the parse boundary before anyone uses it.
const selfHosted = await shipSwaghausConvexApp({
	root: "examples/convex-swaghaus",
	deploymentName: "swaghaus",
	env: workosEnv,
	selfHostedUrl: "http://127.0.0.1:3210",
	selfHostedAdminKey: "demo|key",
	spawn: async (input) => {
		assert.equal(input.env.CONVEX_SELF_HOSTED_URL, "http://127.0.0.1:3210");
		return {
			exitCode: 0,
			stdout: "Deployed http://127.0.0.1:3210\n",
			stderr: "",
		};
	},
});
assert.equal(selfHosted.phase, "deployed");
if (selfHosted.phase === "deployed") {
	console.log(
		`self-hosted mode=${selfHosted.receipt.mode} url=${selfHosted.receipt.deploymentUrl} live=${selfHosted.preflight.live}`,
	);
}

// A self-hosted lane may not claim a convex.cloud host.
try {
	parseDeployReceipt({
		ok: true,
		deploymentUrl: "https://swaghaus.convex.cloud",
		deploymentName: "swaghaus",
		mocked: false,
		mode: "self-hosted",
	});
	assert.fail("expected the parser to refuse a mismatched URL family");
} catch (error) {
	assert.ok(error instanceof ConvexDeployParseError);
	console.log(`refused-receipt field=${error.field}`);
}

const findings = parseImpedanceRecords([
	...convexImpedanceFindings({ paradigm: "relational", features: ["replay"] }),
]);
console.log(
	`impedance ${findings
		.map((finding) => `${finding.code}:${finding.severity}`)
		.join(" ")}`,
);

console.log("convex-swaghaus-deploy-adapter:ok");
