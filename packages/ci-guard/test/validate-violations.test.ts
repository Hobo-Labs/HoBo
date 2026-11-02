/**
 * This validator is the thing that stops CI's own safety properties eroding.
 * Each check corresponds to a rule somebody deliberately established — the PR
 * gate blocks, E2E authenticates by OIDC rather than a stored secret, the
 * sandbox role is not wildcarded, teardown runs even when the job fails — and
 * every one of them is enforced by a single `if` that pushes a violation.
 *
 * The existing suite verifies that a correct contract passes. That is the half
 * which cannot fail informatively: a validator that returned `passed: true`
 * unconditionally would satisfy it completely, and CI would keep reporting a
 * green contract while every rule it encodes quietly stopped being checked.
 *
 * So this file breaks one invariant at a time and asserts the specific code
 * that comes back. The code matters as much as the failure: it is what a
 * developer greps for when the guard rejects their change, and a violation that
 * reported the wrong one would send them to fix the wrong thing.
 */
import { describe, expect, it } from "vitest";

import { createHoboCiFabricContract } from "../src/contract.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../src/json.js";
import { validateCiFabricContract } from "../src/validate.js";
import type { WorkflowFile } from "../src/workflows.js";

/** A structurally valid contract; each test breaks exactly one field. */
function contract() {
	return createHoboCiFabricContract();
}

type Mutable = JsonObject;
type Contract = ReturnType<typeof createHoboCiFabricContract>;

function object(value: JsonValue | undefined): Mutable {
	if (!isJsonObject(value)) throw new Error("expected JSON object");
	return value;
}

function array(value: JsonValue | undefined): JsonValue[] {
	if (!Array.isArray(value)) throw new Error("expected JSON array");
	return value;
}

/**
 * Apply a deep edit to a frozen contract by cloning it first.
 *
 * The contract is deliberately immutable, so a test cannot poke a field
 * directly — and re-deriving one by hand would drift from the real shape.
 */
function broken(edit: (draft: Mutable) => void) {
	// SAFETY: JSON cloning preserves the factory's contract shape; the edit only changes fields under test.
	const draft = JSON.parse(JSON.stringify(contract())) as Contract & Mutable;
	edit(object(draft));
	return draft;
}

/** Validate without workflow files — isolates the contract-shape checks. */
function codesFor(
	value: ReturnType<typeof createHoboCiFabricContract>,
	workflows: readonly WorkflowFile[] | null = null,
): string[] {
	return validateCiFabricContract(value, workflows).violations.map(
		(v) => v.code,
	);
}

describe("a correct contract", () => {
	it("passes and reports full coverage", () => {
		const report = validateCiFabricContract(contract(), null);
		expect(report.passed).toBe(true);
		expect(report.violations).toEqual([]);
		expect(report.coverage.length).toBeGreaterThan(0);
	});

	it("reports no coverage once anything is violated", () => {
		// Coverage is a claim about which properties CI is known to enforce.
		// Reporting it alongside a violation would let a partly-broken contract
		// still look like it covered everything.
		const report = validateCiFabricContract(
			broken((d) => {
				object(d.workflow).pullRequestGate = {
					...object(object(d.workflow).pullRequestGate),
					blocksPullRequest: false,
				};
			}),
			null,
		);
		expect(report.passed).toBe(false);
		expect(report.coverage).toEqual([]);
	});
});

describe("the pull-request gate", () => {
	it("must block on failure", () => {
		// A non-blocking gate is decoration: it runs, it goes red, and the merge
		// button stays green.
		expect(
			codesFor(
				broken((d) => {
					object(object(d.workflow).pullRequestGate).blocksPullRequest = false;
				}),
			),
		).toContain("pr-gate.not-blocking");
	});

	it("must block explicitly, not merely truthily", () => {
		// The check is `!== true`, so a gate whose flag deserialised as the
		// string "true" is still refused — the contract is machine-read and a
		// string there means something upstream is not producing what it claims.
		expect(
			codesFor(
				broken((d) => {
					object(object(d.workflow).pullRequestGate).blocksPullRequest = "true";
				}),
			),
		).toContain("pr-gate.not-blocking");
	});

	it("must list every required check", () => {
		// Dropping a check from the gate is the easiest way to make a failing
		// lane stop mattering without anyone noticing.
		const codes = codesFor(
			broken((d) => {
				object(object(d.workflow).pullRequestGate).requiredChecks = [];
			}),
		);
		expect(codes).toContain("pr-gate.missing-checks");
	});

	it("names the checks that are missing", () => {
		// The message is the remediation; without the names a developer has to
		// diff the contract against the source to find out what to add.
		const report = validateCiFabricContract(
			broken((d) => {
				object(object(d.workflow).pullRequestGate).requiredChecks = [];
			}),
			null,
		);
		const violation = report.violations.find(
			(v) => v.code === "pr-gate.missing-checks",
		);
		expect(violation?.message).toMatch(/missing required checks: \S/u);
	});

	it("accepts extra checks beyond the required set", () => {
		// The contract sets a floor, not a ceiling; a team adding their own lane
		// must not be told their gate is wrong.
		const codes = codesFor(
			broken((d) => {
				const gate = object(object(d.workflow).pullRequestGate);
				gate.requiredChecks = [...array(gate.requiredChecks), "extra-lane"];
			}),
		);
		expect(codes).not.toContain("pr-gate.missing-checks");
	});
});

describe("the artifact cache", () => {
	it("must cache wasm artifacts", () => {
		expect(
			codesFor(
				broken((d) => {
					const cache = object(object(d.workflow).artifactCache);
					cache.entries = array(cache.entries).filter(
						(e) => object(e).kind !== "wasm",
					);
				}),
			),
		).toContain("cache.wasm.missing");
	});

	it("must cache OCI artifacts", () => {
		expect(
			codesFor(
				broken((d) => {
					const cache = object(object(d.workflow).artifactCache);
					cache.entries = array(cache.entries).filter(
						(e) => object(e).kind !== "oci",
					);
				}),
			),
		).toContain("cache.oci.missing");
	});

	it("reports both when the cache is empty", () => {
		// Two independent rules; collapsing them into one message would hide half
		// the work needed to fix it.
		const codes = codesFor(
			broken((d) => {
				object(object(d.workflow).artifactCache).entries = [];
			}),
		);
		expect(codes).toContain("cache.wasm.missing");
		expect(codes).toContain("cache.oci.missing");
	});
});

describe("E2E cost gating", () => {
	function withoutGate(kind: string) {
		return broken((d) => {
			const e2e = object(d.e2e);
			e2e.gatedBy = array(e2e.gatedBy).filter((g) => object(g).kind !== kind);
		});
	}

	it("requires all three gates", () => {
		// The gates are what keep a cloud-spending job from running on every
		// push. Any one missing makes it reachable by an unintended trigger.
		for (const kind of ["pull-request-label", "schedule", "manual"]) {
			expect(codesFor(withoutGate(kind))).toContain("e2e.cost-gate.missing");
		}
	});

	it("requires a label gate to actually name a label", () => {
		// A gate entry with no label is a gate that matches nothing — or
		// everything, depending on the runner.
		expect(
			codesFor(
				broken((d) => {
					const e2e = object(d.e2e);
					e2e.gatedBy = array(e2e.gatedBy).map((g) =>
						object(g).kind === "pull-request-label"
							? { ...object(g), label: "" }
							: g,
					);
				}),
			),
		).toContain("e2e.cost-gate.missing");
	});

	it("requires a schedule gate to name a cron", () => {
		expect(
			codesFor(
				broken((d) => {
					const e2e = object(d.e2e);
					e2e.gatedBy = array(e2e.gatedBy).map((g) =>
						object(g).kind === "schedule" ? { ...object(g), cron: "" } : g,
					);
				}),
			),
		).toContain("e2e.cost-gate.missing");
	});

	it("pins the schedule to the agreed cron", () => {
		// The contract fixes when the expensive lane runs. A drifted cron is how
		// a weekly job quietly becomes an hourly one.
		expect(
			codesFor(
				broken((d) => {
					object(object(d.workflow).triggers).schedule = "* * * * *";
				}),
			),
		).toContain("e2e.cost-gate.missing");
	});
});

describe("secretless E2E authentication", () => {
	it("requires an OIDC id-token", () => {
		// The whole point of the secretless design: the job federates rather than
		// holding a long-lived cloud credential.
		expect(
			codesFor(
				broken((d) => {
					object(object(d.e2e).permissions)["id-token"] = "read";
				}),
			),
		).toContain("oidc.missing");
	});

	it("requires the federation auth mode", () => {
		expect(
			codesFor(
				broken((d) => {
					object(object(d.e2e).auth).mode = "static-key";
				}),
			),
		).toContain("oidc.missing");
	});

	it("requires stored secrets to be forbidden explicitly", () => {
		expect(
			codesFor(
				broken((d) => {
					object(object(d.e2e).auth).forbidsStoredSecrets = false;
				}),
			),
		).toContain("oidc.secretless-required");
	});

	it("rejects an env key whose name suggests a secret", () => {
		// Name-based detection catches the common case where somebody adds
		// `AWS_SECRET_ACCESS_KEY` to the job env out of habit.
		expect(
			codesFor(
				broken((d) => {
					object(object(d.e2e).env).MY_SECRET_TOKEN = "x";
				}),
			),
		).toContain("oidc.stored-secret");
	});

	it("rejects an env value that references the secrets context", () => {
		// And value-based detection catches the case where the name is innocuous
		// but the value is `${{ secrets.FOO }}`.
		expect(
			codesFor(
				broken((d) => {
					object(object(d.e2e).env).TOKEN = "${{ secrets.FOO }}";
				}),
			),
		).toContain("oidc.stored-secret");
	});

	it("names the offending keys, sorted", () => {
		// Sorted so the message is stable between runs — an unstable diagnostic
		// makes a CI failure look like it changed when it did not.
		const report = validateCiFabricContract(
			broken((d) => {
				const env = object(object(d.e2e).env);
				env.Z_SECRET = "x";
				env.A_SECRET = "y";
			}),
			null,
		);
		const violation = report.violations.find(
			(v) => v.code === "oidc.stored-secret",
		);
		expect(violation?.message).toContain("A_SECRET, Z_SECRET");
	});

	it("accepts an env that references no secrets", () => {
		expect(
			codesFor(
				broken((d) => {
					object(object(d.e2e).env).LOG_LEVEL = "debug";
				}),
			),
		).not.toContain("oidc.stored-secret");
	});
});

describe("the sandbox cloud role", () => {
	function withActions(actions: string[]) {
		return broken((d) => {
			object(object(d.e2e).auth).cloudRole = {
				...object(object(object(d.e2e).auth).cloudRole),
				allowedActions: actions,
			};
		});
	}

	it("rejects a bare wildcard", () => {
		// A role that can do anything defeats the point of federating into a
		// sandbox at all.
		expect(codesFor(withActions(["*"]))).toContain("oidc.role.overbroad");
	});

	it("rejects each forbidden action family", () => {
		// These four are the ones that let a compromised CI job escalate beyond
		// the sandbox: mint credentials, spend money, read secrets, or
		// administer resources.
		for (const action of [
			"iam:CreateUser",
			"billing:ModifyAccount",
			"secrets:GetSecretValue",
			"resources:admin",
		]) {
			expect(codesFor(withActions([action]))).toContain("oidc.role.overbroad");
		}
	});

	it("names the offending actions", () => {
		const report = validateCiFabricContract(
			withActions(["iam:CreateUser", "compute:Run"]),
			null,
		);
		const violation = report.violations.find(
			(v) => v.code === "oidc.role.overbroad",
		);
		expect(violation?.message).toContain("iam:CreateUser");
		expect(violation?.message).not.toContain("compute:Run");
	});

	it("accepts narrowly scoped actions", () => {
		expect(
			codesFor(withActions(["compute:Run", "storage:PutObject"])),
		).not.toContain("oidc.role.overbroad");
	});
});

describe("the E2E fixture and assertions", () => {
	it("requires the hello-bindle fixture", () => {
		expect(
			codesFor(
				broken((d) => {
					object(d.e2e).fixture = "examples/something-else";
				}),
			),
		).toContain("e2e.fixture.missing");
	});

	it("requires the deploy command to name the fixture", () => {
		// A contract naming one fixture while deploying another would report a
		// passing E2E for something nobody meant to test.
		expect(
			codesFor(
				broken((d) => {
					object(object(d.e2e).deploy).command = "hobo up other-app";
				}),
			),
		).toContain("e2e.fixture.missing");
	});

	it("requires an HTTPS live-url assertion", () => {
		expect(
			codesFor(
				broken((d) => {
					const deploy = object(object(d.e2e).deploy);
					deploy.asserts = array(deploy.asserts).filter(
						(a) => a !== "live-url.https",
					);
				}),
			),
		).toContain("e2e.live-url-assertion.missing");
	});

	it("requires a 2xx live-url assertion", () => {
		// HTTPS alone proves a certificate, not a working app; the status
		// assertion is what makes the E2E mean anything.
		expect(
			codesFor(
				broken((d) => {
					const deploy = object(object(d.e2e).deploy);
					deploy.asserts = array(deploy.asserts).filter(
						(a) => a !== "live-url.http-2xx",
					);
				}),
			),
		).toContain("e2e.live-url-assertion.missing");
	});
});

describe("teardown and the orphan sweeper", () => {
	it("requires teardown to run unconditionally", () => {
		// Teardown that only runs on success leaks exactly the resources a failed
		// run created — the case that most needs cleaning up.
		expect(
			codesFor(
				broken((d) => {
					object(object(d.e2e).teardown).always = false;
				}),
			),
		).toContain("e2e.teardown.not-always");
	});

	it("requires an orphan sweeper", () => {
		// Teardown can itself fail; the sweeper is the second line, and without
		// it a cancelled run leaves cloud resources billing indefinitely.
		expect(
			codesFor(
				broken((d) => {
					object(object(d.e2e).teardown).orphanSweeper = {
						enabled: false,
					};
				}),
			),
		).toContain("e2e.orphan-sweeper.missing");
	});
});

describe("the quarantine lane", () => {
	it("must continue on error", () => {
		// Quarantine exists to hold known-flaky tests without blocking anyone; a
		// lane that stops on error is just a slower blocking lane.
		expect(
			codesFor(
				broken((d) => {
					object(object(d.e2e).quarantine).continueOnError = false;
				}),
			),
		).toContain("e2e.quarantine.blocks");
	});

	it("must not block pull requests", () => {
		expect(
			codesFor(
				broken((d) => {
					object(object(d.e2e).quarantine).blocksPullRequest = true;
				}),
			),
		).toContain("e2e.quarantine.blocks");
	});
});

describe("the schema version", () => {
	it("rejects an unsupported schema", () => {
		// The contract is machine-read; a version this validator does not
		// understand must not be silently validated against the wrong rules.
		const codes = codesFor(
			broken((d) => {
				d.schema = "hobo.ci-fabric/v999";
			}),
		);
		expect(codes).toContain("schema.unsupported");
	});

	it("still validates the rest of the contract alongside a bad schema", () => {
		// A single blocking error would hide every other problem and turn one
		// fix into several round trips.
		const codes = codesFor(
			broken((d) => {
				d.schema = "hobo.ci-fabric/v999";
				object(object(d.workflow).pullRequestGate).blocksPullRequest = false;
			}),
		);
		expect(codes).toContain("schema.unsupported");
		expect(codes).toContain("pr-gate.not-blocking");
	});
});

describe("several violations at once", () => {
	it("every broken rule is reported, not just the first", () => {
		// The validator runs in CI, where a developer sees one report per push.
		// Stopping at the first violation would make fixing a drifted contract an
		// arbitrarily long sequence of pushes.
		const codes = codesFor(
			broken((d) => {
				object(object(d.workflow).pullRequestGate).blocksPullRequest = false;
				object(object(d.workflow).artifactCache).entries = [];
				object(object(d.e2e).teardown).always = false;
				object(object(d.e2e).auth).forbidsStoredSecrets = false;
			}),
		);
		expect(codes).toContain("pr-gate.not-blocking");
		expect(codes).toContain("cache.wasm.missing");
		expect(codes).toContain("cache.oci.missing");
		expect(codes).toContain("e2e.teardown.not-always");
		expect(codes).toContain("oidc.secretless-required");
	});

	it("every violation carries a code and a message", () => {
		// A violation with an empty message is one a developer cannot act on.
		const report = validateCiFabricContract(
			broken((d) => {
				object(object(d.workflow).pullRequestGate).requiredChecks = [];
				object(object(d.e2e).quarantine).continueOnError = false;
			}),
			null,
		);
		expect(report.violations.length).toBeGreaterThan(0);
		for (const violation of report.violations) {
			expect(violation.code.length).toBeGreaterThan(0);
			expect(violation.message.trim().length).toBeGreaterThan(0);
		}
	});
});

describe("workflow files", () => {
	it("are skipped entirely when null is passed", () => {
		// A caller validating a contract in isolation — before any workflow files
		// exist — must not be told the files are missing.
		const codes = codesFor(contract(), null);
		expect(codes).toEqual([]);
	});

	it("a missing hobo-ci.yml is reported", () => {
		expect(codesFor(contract(), [])).toContain("workflow.hobo-ci.missing");
	});

	it("a missing examples-e2e.yml is reported", () => {
		expect(codesFor(contract(), [])).toContain("workflow.examples-e2e.missing");
	});

	it("both missing files are reported together", () => {
		const codes = codesFor(contract(), []);
		expect(codes).toContain("workflow.hobo-ci.missing");
		expect(codes).toContain("workflow.examples-e2e.missing");
	});

	it("an empty hobo-ci.yml reports each missing job separately", () => {
		// Four independent jobs; one combined message would understate how much
		// is missing.
		const codes = codesFor(contract(), [
			{
				name: "hobo-ci.yml",
				path: ".github/workflows/hobo-ci.yml",
				content: "",
			},
		]);
		expect(codes).toContain("workflow.pr-gate.missing");
		expect(codes).toContain("workflow.main-gate.missing");
		expect(codes).toContain("workflow.ci-guard.missing");
		expect(codes).toContain("workflow.secret-scan.missing");
	});

	it("a pr-gate that does not run agent:check is reported", () => {
		const codes = codesFor(contract(), [
			{
				name: "hobo-ci.yml",
				path: ".github/workflows/hobo-ci.yml",
				content:
					"jobs:\n  pr-gate:\n  main-gate:\n  ci-guard:\n  secret-scan:\n",
			},
		]);
		expect(codes).toContain("workflow.pr-gate.agent-check");
	});

	it("a pr-gate that runs every lane unfiltered is reported", () => {
		// The affected filter is what keeps the gate fast enough to be blocking.
		// A gate that runs everything gets disabled by whoever is waiting on it.
		const codes = codesFor(contract(), [
			{
				name: "hobo-ci.yml",
				path: ".github/workflows/hobo-ci.yml",
				content: `jobs:
  pr-gate:
    steps:
      - run: pnpm agent:check
      - run: turbo run build typecheck lint test:unit
  main-gate:
  ci-guard:
  secret-scan:
`,
			},
		]);
		expect(codes).toContain("workflow.pr-gate.affected");
	});

	it("an examples-e2e.yml with no jobs reports both as missing", () => {
		const codes = codesFor(contract(), [
			{
				name: "examples-e2e.yml",
				path: ".github/workflows/examples-e2e.yml",
				content: "jobs:\n",
			},
		]);
		expect(codes).toContain("workflow.e2e.job.missing");
		expect(codes).toContain("workflow.e2e.quarantine.missing");
	});

	it("an examples-e2e.yml with no sweeper is reported", () => {
		const codes = codesFor(contract(), [
			{
				name: "examples-e2e.yml",
				path: ".github/workflows/examples-e2e.yml",
				content: "jobs:\n",
			},
		]);
		expect(codes).toContain("e2e.orphan-sweeper.missing");
	});
});
