import { describe, expect, it } from "vitest";

import {
	evaluateRegistrationGuard,
	repositoryPath,
} from "../src/host-runner.js";

describe("evaluateRegistrationGuard", () => {
	it("allows a private repository", () => {
		expect(
			evaluateRegistrationGuard({
				repository: { private: true },
				allowPublic: false,
			}),
		).toEqual({ allowed: true });
	});

	it("refuses a public repository by default", () => {
		const verdict = evaluateRegistrationGuard({
			repository: { private: false },
			allowPublic: false,
		});

		expect(verdict.allowed).toBe(false);
		if (verdict.allowed) return;
		expect(verdict.code).toBe("HOST_RUNNER_PUBLIC_REPO_REFUSED");
		expect(verdict.reason).toContain("PUBLIC repository");
		expect(verdict.reason).toContain("--allow-public");
	});

	it("calls out fork pull-request workflows as the specific danger", () => {
		const verdict = evaluateRegistrationGuard({
			repository: { private: false, forkPullRequestWorkflows: true },
			allowPublic: false,
		});

		expect(verdict.allowed).toBe(false);
		if (verdict.allowed) return;
		expect(verdict.reason).toContain("Fork pull-request workflows are enabled");
	});

	it("omits the fork warning when fork workflows are not enabled", () => {
		const verdict = evaluateRegistrationGuard({
			repository: { private: false, forkPullRequestWorkflows: false },
			allowPublic: false,
		});

		expect(verdict.allowed).toBe(false);
		if (verdict.allowed) return;
		expect(verdict.reason).not.toContain("Fork pull-request workflows");
	});

	it("allows a public repository only when the operator opts in explicitly", () => {
		expect(
			evaluateRegistrationGuard({
				repository: { private: false, forkPullRequestWorkflows: true },
				allowPublic: true,
			}),
		).toEqual({ allowed: true });
	});
});

describe("repositoryPath", () => {
	it("addresses the repository record used for the visibility check", () => {
		expect(repositoryPath("Hobo-Labs", "HoBo")).toBe(
			"/repos/Hobo-Labs/HoBo",
		);
	});
});
