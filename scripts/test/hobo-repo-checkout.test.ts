import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const checkoutSha = "11bd71901bbe5b1630ceea73d27597364c9af683";
const workflow = readFileSync(
	join(root, ".github/workflows/hobo-ci.yml"),
	"utf8",
);
const action = readFileSync(
	join(root, ".github/actions/hobo-repo-checkout/action.yml"),
	"utf8",
);

describe("hobo-repo-checkout wiring", () => {
	it("probes mirror and alternates before remote attempts", () => {
		expect(action).toContain("box-git-mirror.mts");
		expect(action).toContain("--export-github-env");
		expect(action).toContain("repo-checkout.mts");
		const probe = action.indexOf("Probe box git mirror");
		const mirrorCheckout = action.indexOf("Checkout from bare mirror");
		const remote = action.indexOf("Remote checkout (attempt 1)");
		expect(probe).toBeLessThan(mirrorCheckout);
		expect(mirrorCheckout).toBeLessThan(remote);
	});

	it("main workspace shards use hobo-repo-checkout with a fail-closed marker", () => {
		const block = workflow.slice(
			workflow.indexOf("\n  main_workspace_tests:"),
			workflow.indexOf("\n  main_gate_finish:"),
		);
		expect(block).toContain("Resolve repo-local actions");
		expect(block).toContain("uses: ./.github/actions/hobo-repo-checkout");
		expect(block).toContain('bootstrap-composite-actions: "false"');
		expect(block).toContain("marker: scripts/ci/ci-trace.mts");
		expect(block).toContain("submodules: recursive");
	});

	it("clears mirror git config before remote retries after mirror failure", () => {
		expect(action).toContain(
			"Disable box git mirror after mirror checkout failure",
		);
		const disable = action.indexOf(
			"Disable box git mirror after mirror checkout failure",
		);
		const remote = action.indexOf("Remote checkout (attempt 1)");
		expect(disable).toBeGreaterThan(-1);
		expect(disable).toBeLessThan(remote);
	});

	it("retains three pinned remote checkout attempts with backoff", () => {
		expect(
			action.match(new RegExp(`actions/checkout@${checkoutSha}`, "g")),
		).toHaveLength(6);
		expect(action).toContain("sleep 8");
	});
});
