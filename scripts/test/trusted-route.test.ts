import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { asList, asObject, asText } from "../ci/attestation.mts";
import { workflowDocument } from "../lib/workflow-job-steps.mts";

describe("base-controlled attestation verification", () => {
	for (const workflow of ["hobo-ci.yml", "release-hobo.yml"]) {
		it(`${workflow} loads the route action and verifier from the event base`, () => {
			const doc = workflowDocument(
				readFileSync(`.github/workflows/${workflow}`, "utf8"),
			);
			const route = asObject(asObject(doc.jobs)?.route);
			const steps = asList(route?.steps)?.map(asObject) ?? [];
			const checkout = steps.find(
				(step) => asObject(step?.with)?.path === ".ci-trusted",
			);
			assert.ok(checkout);
			assert.match(
				asText(checkout.uses) ?? "",
				/^actions\/checkout@[a-f0-9]{40}$/u,
			);
			const options = asObject(checkout.with);
			assert.equal(
				options?.ref,
				"${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.sha }}",
			);
			assert.equal(options?.["persist-credentials"], false);
			const sparse = asText(options?.["sparse-checkout"]) ?? "";
			for (const path of [
				".github/actions/route-runner",
				"scripts/ci/attestation.mts",
				"scripts/ci/verify-attestation.mts",
			])
				assert.ok(sparse.split(/\s+/u).includes(path), path);
			const routeStep = steps.find((step) => step?.id === "route");
			assert.equal(
				routeStep?.uses,
				"./.ci-trusted/.github/actions/route-runner",
			);
		});
	}

	it("executes the verifier beside the checked-out base action, never the tested copy", () => {
		const workspace = mkdtempSync(join(tmpdir(), "hobo-trusted-route-"));
		try {
			const action = workflowDocument(
				readFileSync(".github/actions/route-runner/action.yml", "utf8"),
			);
			const shell = asText(
				asObject(asList(asObject(action.runs)?.steps)?.[0])?.run,
			);
			assert.ok(shell);
			const actionDir = join(
				workspace,
				".ci-trusted",
				".github",
				"actions",
				"route-runner",
			);
			const trustedDir = join(workspace, ".ci-trusted", "scripts", "ci");
			const testedDir = join(workspace, "scripts", "ci");
			mkdirSync(actionDir, { recursive: true });
			mkdirSync(trustedDir, { recursive: true });
			mkdirSync(testedDir, { recursive: true });
			const marker = join(workspace, "verifier-cwd");
			const program = (value: string) =>
				`import { appendFileSync, writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, process.cwd()); appendFileSync(process.env.GITHUB_OUTPUT, "attested=${value}\\nattested-jobs=[]\\n");`;
			writeFileSync(join(testedDir, "verify-attestation.mts"), program("true"));
			writeFileSync(
				join(trustedDir, "verify-attestation.mts"),
				program("false"),
			);
			const output = join(workspace, "output");
			const run = () => {
				writeFileSync(output, "");
				const child = spawnSync("bash", ["-c", shell], {
					cwd: workspace,
					encoding: "utf8",
					env: {
						...process.env,
						GITHUB_ACTION_PATH: actionDir,
						GITHUB_OUTPUT: output,
					},
				});
				assert.equal(child.status, 0, child.stderr);
				return readFileSync(output, "utf8");
			};
			assert.equal(run(), "attested=false\nattested-jobs=[]\n");
			assert.equal(readFileSync(marker, "utf8"), workspace);
			rmSync(join(trustedDir, "verify-attestation.mts"));
			assert.equal(run(), "attested=false\nattested-jobs=[]\n");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
