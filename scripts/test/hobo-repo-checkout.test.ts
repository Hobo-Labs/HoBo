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
const pricingWorkflow = readFileSync(
	join(root, ".github/workflows/pricing-ci.yml"),
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

	it("the pricing gate verifies the preflight script before running it", () => {
		const block = pricingWorkflow.slice(
			pricingWorkflow.indexOf("\n  pricing-gate:"),
			pricingWorkflow.indexOf("\n  pricing-models:"),
		);
		expect(block).toContain("uses: $/.github/actions/hobo-repo-checkout");
		expect(block).toContain("scripts/ci-runner-preflight.mts");
		const miseLock = readFileSync(join(root, "mise.lock"), "utf8");
		const sidecar = miseLock.match(/aube = \{ path = "([^"]+)"/)?.[1];
		expect(sidecar).toBeTruthy();
		expect(block).toContain(`${sidecar}/aube-lock.yaml`);
		expect(block).toContain(`${sidecar}/package.json`);
		expect(block.indexOf("hobo-repo-checkout")).toBeLessThan(
			block.indexOf("uses: $/.github/actions/ci-runner-preflight"),
		);
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

	it("retries an apparently successful checkout when its marker is missing", () => {
		const work = mkdtempSync(join(tmpdir(), "hobo-checkout-marker-"));
		const verifier = join(
			root,
			".github/actions/hobo-repo-checkout/verify-marker.sh",
		);
		try {
			const verify = (marker: string) =>
				spawnSync("bash", [verifier], {
					cwd: work,
					env: { ...process.env, CHECKOUT_MARKER: marker },
					encoding: "utf8",
				});
			expect(verify("").status).toBe(0);
			expect(verify("required.mts").status).not.toBe(0);
			writeFileSync(join(work, "required.mts"), "export {};\n");
			expect(verify("required.mts").status).toBe(0);
			expect(verify("required.mts\nsecond file").status).not.toBe(0);
			writeFileSync(join(work, "second file"), "present\n");
			expect(verify("required.mts\nsecond file\n").status).toBe(0);

			for (const attempt of [1, 2]) {
				expect(action).toContain(`id: verify${attempt}`);
				expect(action).toContain(
					`steps.remote${attempt}.outcome != 'success' || steps.verify${attempt}.outcome != 'success'`,
				);
			}
			expect(action).toContain("id: verify3");
			expect(action).toContain('steps.verify3.outcome }}" = "success"');
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});

	it("allows remote fallback after a failed mirror checkout", () => {
		const mirrorStep = action.slice(
			action.indexOf("name: Checkout from bare mirror"),
			action.indexOf(
				"name: Disable box git mirror after mirror checkout failure",
			),
		);
		expect(mirrorStep).toContain("continue-on-error: true");
	});

	it.each([
		1, 2, 3,
	])("checks the marker after remote attempt %i before proceeding", (attempt) => {
		const block = action
			.split(`    - name: Verify remote checkout (attempt ${attempt})\n`)[1]
			?.split("\n    - name: ")[0];
		expect(block).toContain(`id: verify${attempt}`);
		expect(block).toContain(
			'run: bash "${GITHUB_ACTION_PATH}/verify-marker.sh"',
		);
	});
});
