// Observe-only adoption of a Vercel Git-integration deployment: the JSON
// GitHub's Deployments API returns (recorded shapes, no network), and the
// verdict a realizer reports.
import { describe, expect, it } from "vitest";

import {
	isVercelGitEnvironment,
	vercelAdoptionVerdict,
	vercelGitDeploymentRecords,
	vercelGitDeploymentStatus,
} from "../src/index.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

// The shape `GET /repos/{owner}/{repo}/deployments?sha=` returns for a push
// Vercel's Git integration built (fields this module reads, and some it does not).
const LISTING = [
	{
		id: 301,
		sha: SHA,
		ref: "main",
		environment: "Production – hobo-ci",
		creator: { login: "vercel[bot]" },
	},
	{ id: 302, sha: SHA, ref: "main", environment: "Production – hobo-ci-relay" },
	{ id: 303, sha: SHA, ref: "main", environment: "Preview – hobo-ci" },
	{ id: 304, sha: OTHER, ref: "main", environment: "Production – hobo-ci" },
	{ id: "305", sha: SHA, environment: "production - hobo-ci" },
	{ sha: SHA, environment: "Production – hobo-ci" },
	"not a record",
];

describe("Vercel Git-integration deployment records", () => {
	it("names the project's environment exactly, never a project it is a prefix of", () => {
		expect(
			isVercelGitEnvironment("Production – hobo-ci", "hobo-ci", "production"),
		).toBe(true);
		expect(
			isVercelGitEnvironment(
				"Production – hobo-ci-relay",
				"hobo-ci",
				"production",
			),
		).toBe(false);
		expect(
			isVercelGitEnvironment("Preview – hobo-ci", "hobo-ci", "production"),
		).toBe(false);
		expect(
			isVercelGitEnvironment("Preview – hobo-ci", "hobo-ci", "preview"),
		).toBe(true);
	});

	it("keeps only the project's production records of the commit, and nothing malformed", () => {
		expect(
			vercelGitDeploymentRecords(LISTING, {
				project: "hobo-ci",
				target: "production",
				commit: SHA,
			}).map((record) => record.id),
		).toEqual(["301", "305"]);
		expect(
			vercelGitDeploymentRecords(
				{ message: "Not Found" },
				{ project: "hobo-ci", target: "production", commit: SHA },
			),
		).toEqual([]);
	});

	it("reads the latest status: success is READY with its URL, inactive is SUPERSEDED", () => {
		expect(
			vercelGitDeploymentStatus([
				{
					state: "success",
					environment_url: "https://hobo-ci-abc123.vercel.app",
					target_url: "https://vercel.com/hobo/hobo-ci/Fx1",
				},
				{ state: "pending" },
			]),
		).toEqual({
			readyState: "READY",
			url: "https://hobo-ci-abc123.vercel.app",
			inspectorUrl: "https://vercel.com/hobo/hobo-ci/Fx1",
		});
		expect(vercelGitDeploymentStatus([{ state: "inactive" }]).readyState).toBe(
			"SUPERSEDED",
		);
		expect(vercelGitDeploymentStatus([{ state: "failure" }]).readyState).toBe(
			"ERROR",
		);
		expect(
			vercelGitDeploymentStatus([{ state: "in_progress" }]).readyState,
		).toBe("BUILDING");
		expect(vercelGitDeploymentStatus([]).readyState).toBe("QUEUED");
	});

	it("keeps the state of the latest status and the URL of the newest one that names it", () => {
		expect(
			vercelGitDeploymentStatus([
				{ state: "in_progress" },
				{
					state: "pending",
					environment_url: "https://hobo-ci-abc123.vercel.app",
				},
			]),
		).toEqual({
			readyState: "BUILDING",
			url: "https://hobo-ci-abc123.vercel.app",
		});
	});

	it("drops a URL that is not https and an inspector URL that is not Vercel's", () => {
		expect(
			vercelGitDeploymentStatus([
				{
					state: "success",
					environment_url: "http://hobo-ci.vercel.app",
					target_url: "https://example.test/x",
				},
			]),
		).toEqual({ readyState: "READY" });
	});
});

describe("the observe-only adoption verdict", () => {
	it("converges only on a READY deployment of the pinned commit", () => {
		expect(
			vercelAdoptionVerdict(
				{ commit: SHA, readyState: "READY" },
				{ commit: SHA },
			),
		).toEqual({ kind: "converged", readyState: "READY" });
		expect(
			vercelAdoptionVerdict(
				{ commit: SHA, readyState: "BUILDING" },
				{ commit: SHA },
			).kind,
		).toBe("converging");
	});

	it("blocks a deployment of another commit, a failed one and a superseded one", () => {
		expect(
			vercelAdoptionVerdict(
				{ commit: OTHER, readyState: "READY" },
				{ commit: SHA },
			),
		).toMatchObject({ kind: "blocked", readyState: "COMMIT_MISMATCH" });
		expect(
			vercelAdoptionVerdict(
				{ commit: SHA, readyState: "ERROR" },
				{ commit: SHA },
			).kind,
		).toBe("blocked");
		expect(
			vercelAdoptionVerdict(
				{ commit: SHA, readyState: "SUPERSEDED" },
				{ commit: SHA },
			).kind,
		).toBe("blocked");
	});
});
