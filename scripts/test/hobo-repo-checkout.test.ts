import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const checkoutSha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
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
		expect(block).toContain("uses: $/.github/actions/hobo-repo-checkout");
		expect(block).toContain('bootstrap-composite-actions: "false"');
		expect(block).toContain("marker: scripts/ci/ci-trace.mts");
		expect(block).toContain("submodules: recursive");
	});

	it("disables a prior sparse cone before remote checkout attempts", () => {
		expect(action).toContain(
			"Disable prior sparse cone before full remote checkout",
		);
		expect(action).toContain("--prepare-full-worktree");
		const disableSparse = action.indexOf(
			"Disable prior sparse cone before full remote checkout",
		);
		const remote = action.indexOf("Remote checkout (attempt 1)");
		expect(disableSparse).toBeGreaterThan(-1);
		expect(disableSparse).toBeLessThan(remote);
	});

	it("retries remote checkout when sparse prepare fails on a partial clone", () => {
		expect(action).toMatch(
			/id: prepare_full_worktree[\s\S]*?continue-on-error: true[\s\S]*?--prepare-full-worktree/,
		);
		expect(action).toContain("Reset partial clone after failed sparse prepare");
		const prepare = action.indexOf("id: prepare_full_worktree");
		const reset = action.indexOf(
			"Reset partial clone after failed sparse prepare",
		);
		const remote = action.indexOf("Remote checkout (attempt 1)");
		expect(prepare).toBeGreaterThan(-1);
		expect(reset).toBeGreaterThan(prepare);
		expect(remote).toBeGreaterThan(reset);
		const resetBlock = action.slice(reset, remote);
		expect(resetBlock).toContain(
			"steps.prepare_full_worktree.outcome != 'success'",
		);
		expect(resetBlock).toContain("rm -rf .git");
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
	it.each([
		1, 2,
	])("checks the marker after remote attempt %i before retrying", (attempt) => {
		const block = action
			.split(`    - name: Verify remote checkout (attempt ${attempt})\n`)[1]
			?.split("\n    - name: ")[0];
		const markerCheck = block?.split("      run: |\n")[1];
		if (!markerCheck) throw new Error("marker check is absent");
		const script = markerCheck
			.split("\n")
			.map((line) => line.replace(/^        /, ""))
			.join("\n");
		const directory = mkdtempSync(join(tmpdir(), "hobo-checkout-marker-"));
		try {
			const run = (marker: string) =>
				spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", script], {
					cwd: directory,
					env: { CHECKOUT_MARKER: marker },
					encoding: "utf8",
				});
			expect(run("").status).toBe(0);
			expect(run("marker").status).toBe(1);
			writeFileSync(join(directory, "marker"), "ok");
			expect(run("marker").status).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
