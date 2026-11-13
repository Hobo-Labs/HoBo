#!/usr/bin/env node
/**
 * `pnpm run fleet:outcome <id>` (ADR-0182): runs one system outcome of the
 * fleet design and prints its `fleet-verification.json` object,
 * `{ id, pass, command, evidence, measured, fallbacks }`.
 *
 * The outcome table (`OUTCOMES`) holds each outcome's Check commands, its
 * Threshold, its "Threshold if a fallback is taken" and the assumptions that
 * fallback names, as data. One outcome:
 *
 * 1. fails at once when a file its Check names does not exist;
 * 2. runs the Check commands in order (stopping at the first that fails), each
 *    `vitest run` with its JSON reporter so skipped and todo tests are counted;
 * 3. evaluates its threshold (the soak figures for O20);
 * 4. passes only when every command exited zero, no test was skipped, and the
 *    threshold holds.
 *
 * Fallbacks: `fleet-fallbacks.json` at the root lists the assumption ids whose
 * fallback was taken. An outcome that names one of them is judged against its
 * fallback threshold: a test whose title starts with that id in brackets
 * (`[A13] …`) may skip. For every other outcome no test may skip.
 *
 *   node --import tsx scripts/fleet-outcome.mts <id> [--root=<dir>]
 *
 * Exits 0 when the outcome passes, 1 when it does not, 2 on an unknown id.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The figures a threshold was evaluated on. */
export type Measured = Record<string, number | string | boolean>;

export interface VerificationRecord {
	readonly id: string;
	readonly pass: boolean;
	/** The Check commands, joined with `; `. */
	readonly command: string;
	readonly evidence: readonly string[];
	readonly measured: Measured;
	/** Assumption ids whose fallback was applied to this outcome. */
	readonly fallbacks: readonly string[];
}

export interface ThresholdResult {
	readonly holds: boolean;
	readonly measured: Measured;
	readonly evidence: readonly string[];
}

export interface OutcomeSpec {
	readonly id: string;
	readonly outcome: string;
	readonly checks: readonly string[];
	readonly threshold: string;
	/** "Threshold if a fallback is taken"; absent where no fallback applies. */
	readonly fallbackThreshold?: string;
	/** The assumptions whose fallback changes this outcome. */
	readonly assumptions: readonly string[];
	readonly owner: string;
	/** Checked outside `fleet:verify`'s default run: at cutover, or when the deferred lane runs. */
	readonly deferred?: "cutover" | "L19";
	/** A threshold beyond the commands passing, evaluated after they ran. */
	readonly measure?: (root: string) => ThresholdResult;
}

/** Runs one shell command in `cwd`; returns its exit code. */
export type CommandRunner = (command: string, cwd: string) => number;

const SOAK_FILE = "fleet-soak.json";

/** O20's threshold over `fleet-soak.json` (written by `fleet:soak`). */
export function soakThreshold(root: string): ThresholdResult {
	const path = join(root, SOAK_FILE);
	if (!existsSync(path))
		return {
			holds: false,
			measured: {},
			evidence: [`${SOAK_FILE} was not written`],
		};
	let figures: Readonly<Record<string, number>>;
	try {
		// SAFETY: fleet:soak's own output file; every field read below is checked against a number.
		figures = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
	} catch {
		return {
			holds: false,
			measured: {},
			evidence: [`${SOAK_FILE} is not JSON`],
		};
	}
	const figure = (name: string): number => {
		const value = Number(figures[name]);
		return Number.isFinite(value) ? value : Number.NaN;
	};
	const rules: Array<[string, boolean]> = [
		["duration_s >= 600", figure("duration_s") >= 600],
		["callout_p99_ms < 300", figure("callout_p99_ms") < 300],
		["first_claim_p95_ms < 2000", figure("first_claim_p95_ms") < 2000],
		[
			"events_recorded = events_expected",
			figure("events_recorded") === figure("events_expected"),
		],
		["recovery_s < 60", figure("recovery_s") < 60],
		["new_connection_failures = 0", figure("new_connection_failures") === 0],
		[
			"availability_recorded = availability_expected",
			figure("availability_recorded") === figure("availability_expected"),
		],
	];
	const measured: Measured = {};
	for (const name of [
		"duration_s",
		"callout_p99_ms",
		"first_claim_p95_ms",
		"events_expected",
		"events_recorded",
		"recovery_s",
		"new_connection_failures",
		"availability_expected",
		"availability_recorded",
	])
		measured[name] = figure(name);
	const failed = rules.filter(([, holds]) => !holds).map(([rule]) => rule);
	return {
		holds: failed.length === 0,
		measured,
		evidence: failed.map((rule) => `soak threshold not met: ${rule}`),
	};
}

const vitest = (...files: string[]): string =>
	`pnpm exec vitest run ${files.join(" ")}`;

/** The outcomes of the fleet design's §10.1, as data. */
export const OUTCOMES: readonly OutcomeSpec[] = [
	{
		id: "O1",
		outcome: "One implementation of each idea",
		checks: ["pnpm run fleet:vocabulary"],
		threshold:
			"Zero findings for the nine rules, each over its own pathspecs and less its allowlist",
		assumptions: [],
		owner: "L24",
	},
	{
		id: "O2",
		outcome: "A developer enrolls and runs their own job",
		checks: [
			"pnpm run test:behavior -- features/fleet/enroll-and-run.feature",
			vitest(
				"packages/fleet-authority/acceptance/enroll-and-run.integration.test.ts",
			),
		],
		threshold:
			"Token flow and browser flow each reach a SUCCEEDED receipt, in both files",
		assumptions: [],
		owner: "L26",
	},
	{
		id: "O3",
		outcome: "Per-device isolation on the bus",
		checks: [
			vitest("packages/fleet-nats/test/permissions.integration.test.ts"),
		],
		threshold:
			"For each template, 100% of probed subjects outside it are refused; a connection without TLS is refused",
		fallbackThreshold:
			"The same threshold (permissions minted in the user JWT, tickets single-connection, or extra named subjects, never a wildcard over another member's name)",
		assumptions: ["A1", "A2", "A6"],
		owner: "L08",
	},
	{
		id: "O4",
		outcome: "Claims are first-writer-wins at the server",
		checks: [vitest("packages/fleet-nats/test/claims.integration.test.ts")],
		threshold:
			"8 connections race 500 claims: exactly one holder each; a second publish, a delete, a purge and a rollup from an executor are refused",
		fallbackThreshold:
			"8 executors race 500 claims through the dispatcher's claim service: exactly one holder each; every executor publish on fleet.claim.> is refused",
		assumptions: ["A5"],
		owner: "L08",
	},
	{
		id: "O5",
		outcome: "Revocation meets its service level",
		checks: [
			vitest(
				"packages/fleet-nats/test/revocation.integration.test.ts",
				"packages/fleet-nats/test/registry-view.integration.test.ts",
			),
		],
		threshold:
			"Not ranked and not ordered within 5 s; publishes refused within 10 min with no disconnect; scoped-key removal stops new executor connections; a restarted registry view refuses stale records",
		fallbackThreshold:
			"A3 false, A4 true: publishes refused within 10 min through the disconnect request. A3 and A4 false: the 5 s reader bound and the scoped-key case unchanged; the revoked device's next connection is refused",
		assumptions: ["A3", "A4"],
		owner: "L08",
	},
	{
		id: "O6",
		outcome: "Clone detection without false locks",
		checks: [vitest("packages/fleet/test/membership/generation.test.ts")],
		threshold:
			"Locked on the second divergent refresh; 1,000 randomised lost-response retries: zero locks",
		assumptions: [],
		owner: "L02",
	},
	{
		id: "O7",
		outcome: "Nothing unsigned or altered is trusted",
		checks: [vitest("packages/fleet/test/keys/envelope.property.test.ts")],
		threshold:
			"Any single-bit change, wrong context or unlisted key is rejected, 10,000 cases per envelope kind",
		assumptions: [],
		owner: "L01",
	},
	{
		id: "O8",
		outcome: "A claim cannot be used against an innocent device",
		checks: [vitest("packages/fleet/test/work/claims.test.ts")],
		threshold:
			"Forged, replayed and cross-fleet claims naming a victim: victim never reported; a signature-valid out-of-fleet claim: signer reported once",
		assumptions: [],
		owner: "L04",
	},
	{
		id: "O9",
		outcome: "The trust class cannot be raised by a dispatcher",
		checks: [vitest("packages/fleet/test/work/trust-class.test.ts")],
		threshold:
			"Every cell of the sandbox-tier table for every device class; a mislabelled fork job is stopped by the fence before a step runs",
		assumptions: [],
		owner: "L04",
	},
	{
		id: "O10",
		outcome: "Sandboxes hold",
		checks: [
			vitest("packages/fleet-agent/test/sandbox/isolation.integration.test.ts"),
		],
		threshold:
			"An S1 driver is present; for each driver every isolation property of the probe holds",
		fallbackThreshold:
			"A10: the same properties on the agent-provisioned runsc, rootful or rootless (D58, L40). A11, A12: only drivers whose self-test passed are probed; an S1 driver is still required",
		assumptions: ["A10", "A11", "A12"],
		owner: "L38",
	},
	{
		id: "O11",
		outcome: "The journal store is correct",
		checks: [
			vitest("packages/fleet-nats/test/journal/journal.integration.test.ts"),
		],
		threshold: "All assertions of both suites pass",
		fallbackThreshold:
			"Every assertion of runJournalConformance passes; the harness is absent",
		assumptions: ["A15"],
		owner: "L36",
	},
	{
		id: "O12",
		outcome: "Transports work and are authorised",
		checks: [
			vitest(
				"packages/fleet-p2p/test/p2p.integration.test.ts",
				"packages/connectivity/test/overlay-transport.test.ts",
				"packages/fleet-nats/test/relay/relay.integration.test.ts",
			),
		],
		threshold:
			"For each adapter: 64 MiB transferred with a matching digest; an ungranted, expired or wrong-peer dial refused before any byte",
		fallbackThreshold:
			"p2p is not shipped; its file asserts the adapter reports itself unavailable, and the threshold holds for overlay and bus-relay",
		assumptions: ["A8"],
		owner: "L11, L14, L37",
	},
	{
		id: "O13",
		outcome: "Audit is tamper-evident",
		checks: [
			vitest(
				"packages/fleet/test/audit/chain.test.ts",
				"packages/fleet/test/audit/witness.test.ts",
			),
		],
		threshold:
			"Altering, removing or reordering any entry fails verification; the witness refuses withheld entries; witness lag is logged",
		assumptions: [],
		owner: "L06",
	},
	{
		id: "O14",
		outcome: "The trust anchor cannot be replaced with one key",
		checks: [vitest("packages/fleet/test/keys/trust.test.ts")],
		threshold:
			"A record signed only by a pinned authority key, or only by a pinned witness key, or with a lower sequence, is rejected",
		assumptions: [],
		owner: "L01",
	},
	{
		id: "O15",
		outcome:
			"One-active fleets keep their guarantees and gain safe membership change",
		checks: [
			"pnpm run fleet:moved-tests -- O15",
			vitest(
				"packages/fleet/test/assignment",
				"packages/data-postgres/test/fleet-replica.test.ts",
			),
		],
		threshold:
			"The moved register and replica tests differ only as allowed and pass; replica conformance, log format compatibility and the 5,000-interleaving property hold",
		assumptions: [],
		owner: "L05, L21",
	},
	{
		id: "O16",
		outcome: "The cache fleet behaves as before with no other service",
		checks: [
			"pnpm run fleet:moved-tests -- O16",
			"pnpm exec turbo run test --filter @hobo/ci-vercel",
		],
		threshold:
			"The moved cache-fleet tests differ only as allowed, and every test of the package passes",
		assumptions: [],
		owner: "L17",
	},
	{
		id: "O17",
		outcome: "Cost-based choosing is unchanged",
		checks: [
			"pnpm run fleet:moved-tests -- O17",
			vitest(
				"packages/backend-routing/test/routing.test.ts",
				"packages/data-postgres/test/fleet-policy.test.ts",
			),
		],
		threshold:
			"Both files keep every test title and every expect statement of their base, in order, and pass",
		assumptions: [],
		owner: "L21",
	},
	{
		id: "O18",
		outcome: "Backup and restore work",
		checks: [
			vitest("packages/fleet-authority/test/ops/restore.integration.test.ts"),
		],
		threshold:
			"After restore: every pre-backup member is ACTIVE, every pre-restore credential is refused, the audit chain verifies",
		assumptions: [],
		owner: "L27",
	},
	{
		id: "O19",
		outcome:
			"Keys rotate without an outage; the ceremony splits the operator key",
		checks: [
			vitest(
				"packages/fleet-authority/test/ops/rotation.integration.test.ts",
				"packages/fleet-authority/test/ops/ceremony.test.ts",
			),
		],
		threshold:
			"Zero refused requests during rotation; the two ceremony shares together reconstruct the operator key, either alone does not",
		assumptions: [],
		owner: "L27",
	},
	{
		id: "O20",
		outcome: "Service levels are measurable and the latency ones are met",
		checks: [
			"pnpm run fleet:soak",
			vitest("packages/fleet-authority/test/status/status-feed.test.ts"),
		],
		threshold:
			"duration_s >= 600; callout_p99_ms < 300; first_claim_p95_ms < 2000; events_recorded = events_expected; recovery_s < 60; new_connection_failures = 0; availability_recorded = availability_expected; the status-feed test passes",
		assumptions: [],
		owner: "L26, L27",
		measure: soakThreshold,
	},
	{
		id: "O21",
		outcome: "HoBo runs on it",
		checks: [],
		threshold:
			"`hobo fleet status --json` and a route-job log after cutover: every host is an ACTIVE member; no workflow references a removed variable",
		assumptions: [],
		owner: "Cutover",
		deferred: "cutover",
	},
	{
		id: "O22",
		outcome: "Repository gates",
		checks: ["pnpm run check:all && pnpm run verify:full"],
		threshold:
			"Pass; lint:boundaries, lint:test-deps, codegen:check pass for every new or renamed package; coverage per new package at or above 87/79/89/88",
		assumptions: [],
		owner: "Coordinator",
	},
	{
		id: "O23",
		outcome: "Delivery agents and Camp lifecycle come from the fleet package",
		checks: [
			"pnpm exec turbo run test --filter @hobo/cd --filter @hobo/cd-kube-fleet",
			'! git grep -qE -e "function verifyDpopProof[ (<]" -e "function jwkThumbprint[ (<]" -e "const verifyDpopProof[ :=]" -e "const jwkThumbprint[ :=]" -- packages/cd packages/cd-kube-fleet',
		],
		threshold:
			"The existing agent and inventory tests pass on the adapter and mapper; neither package defines verifyDpopProof or jwkThumbprint",
		assumptions: [],
		owner: "L19",
		deferred: "L19",
	},
	{
		id: "O24",
		outcome: "A GitHub job runs through the fleet end to end",
		checks: [
			vitest(
				"packages/ci-gh-actions/test/fleet-job.integration.test.ts",
				"packages/ci-gh-actions/test/fleet-fence.integration.test.ts",
			),
		],
		threshold:
			"Offer, claim, sealed order, fence and SUCCEEDED receipt for an internal job; a fork job is stopped by the fence, in a real S1 sandbox",
		fallbackThreshold: "The same, on the rootful runtime",
		assumptions: ["A10"],
		owner: "L16",
	},
	{
		id: "O25",
		outcome: "The command line is complete",
		checks: [vitest("packages/hobo/test/fleet-command.contract.test.ts")],
		threshold:
			"Every command parses, calls exactly the client methods and local functions its Calls cell names, and has help text; a token on the command line is refused",
		assumptions: [],
		owner: "L18",
	},
	{
		id: "O26",
		outcome: "The contracts did not drift",
		checks: ["pnpm run fleet:contracts"],
		threshold:
			"The emitted declarations equal each package's contracts/api.snapshot.d.ts, and no snapshot or record changed since the newest Fleet-Contract commit",
		assumptions: [],
		owner: "L24",
	},
	{
		id: "O27",
		outcome: "Vocabulary and documents agree",
		checks: ["pnpm run lint:docs", "pnpm run fleet:docs"],
		threshold:
			"fleet:docs finds no gap: events, ADR mentions and runbooks agree with the documents",
		assumptions: [],
		owner: "L25",
	},
	{
		id: "O28",
		outcome: "Every route admits exactly its auth modes",
		checks: [vitest("packages/fleet-authority/test/routes.test.ts")],
		threshold:
			"For every route and caller kind, 100% of cells answer as the Auth column allows; the device-code flow is refused for a DUAL fleet; the approval page renders every field",
		fallbackThreshold:
			"The verdict route also admits the repository-secret account credential, and only that route",
		assumptions: ["A14"],
		owner: "L09",
	},
	{
		id: "O29",
		outcome: "Sign-in is single use, loopback only and key-bound",
		checks: [vitest("packages/fleet/test/signin/signin.test.ts")],
		threshold:
			"Each sign-in state is used once across two instances; a non-loopback redirect is refused; polls answer pending then once; the person token is bound to the caller's DPoP key",
		assumptions: [],
		owner: "L30",
	},
	{
		id: "O30",
		outcome: "Recording, projection and metering are exact",
		checks: [
			vitest(
				"packages/fleet/test/recorder/recorder.test.ts",
				"packages/fleet/test/recorder/projection.test.ts",
			),
		],
		threshold:
			"Replays append nothing twice; unverifiable envelopes are never recorded; each usage type is emitted once per fact; served records are short-lived and re-signed; rebuilt views equal the originals",
		assumptions: [],
		owner: "L31",
	},
	{
		id: "O31",
		outcome: "Sessions are authorised and transports fall back in order",
		checks: [
			vitest(
				"packages/fleet/test/transport/session.test.ts",
				"packages/fleet/test/transport/selection.test.ts",
			),
		],
		threshold:
			"Each refusal of authoriseSession refuses before any byte; p2p, overlay, bus-relay fall back in order; an in-memory pair carries 64 MiB with a matching digest",
		assumptions: [],
		owner: "L28",
	},
	{
		id: "O32",
		outcome:
			"The route job reads the verdict and the release workflow attests the new images",
		checks: [
			vitest(
				"scripts/test/route-runner-verdict.test.ts",
				"scripts/test/fleet-release-workflow.test.ts",
			),
			"pnpm run actions:lint",
		],
		threshold:
			"OPEN routes as today, NO_MEMBER and NO_CAPACITY refuse the backend, a bad verdict changes nothing; the release workflow builds, attests and adds a bill of materials for each image",
		fallbackThreshold:
			"The job presents the repository-secret account credential instead of the OIDC token; the same routing threshold",
		assumptions: ["A14"],
		owner: "L22",
	},
	{
		id: "O33",
		outcome: "Deployment assets are safe as written",
		checks: [
			vitest("deploy/fleet/test/assets.test.ts"),
			"docker compose -f deploy/fleet/compose.standalone.yml config -q",
			"docker compose -f deploy/fleet/compose.ha.yml config -q",
		],
		threshold:
			"Every NATS listener requires TLS; every Kubernetes workload is non-root, read-only and capability-free; the service definitions run `hobo fleet run`",
		assumptions: [],
		owner: "L23",
	},
	{
		id: "O34",
		outcome:
			"Observations are accepted only as designed and health eligibility is today's",
		checks: [
			vitest("packages/fleet/test/observation"),
			"node --experimental-strip-types packages/fleet/src/verdict-wire.ts",
		],
		threshold:
			"Each acceptance rule has a refusing case; eligibleForActive equals today's decideFleet; the routing properties hold over 6,000 digests; verdict-wire.ts loads with nothing installed",
		assumptions: [],
		owner: "L03",
	},
	{
		id: "O35",
		outcome: "The agent survives what F4, F7 and F19 describe",
		checks: [
			vitest(
				"packages/fleet/test/agent/agent.test.ts",
				"packages/fleet/test/client",
			),
			"node --import tsx packages/fleet/examples/demo.ts",
		],
		threshold:
			"A lost refresh does not lock; trust changes only through acceptTrust; receipts survive a bus outage; the client's PACT tests write fleet-authority.pact.json; the demo prints one receipt per offer",
		assumptions: [],
		owner: "L07",
	},
	{
		id: "O36",
		outcome: "Device key stores and service definitions are correct",
		checks: [
			vitest(
				"packages/fleet-agent/test/keystore",
				"packages/fleet-agent/test/install",
			),
		],
		threshold:
			"runKeyStoreConformance passes for both stores; unsafe key directories are refused; modes are 0700 and 0600; the service definitions equal their fixtures",
		assumptions: [],
		owner: "L10",
	},
	{
		id: "O37",
		outcome: "The authority's token key is shared and rotates",
		checks: [vitest("packages/identity/test/secret-store-kms.test.ts")],
		threshold:
			"Two issuers over one secret store verify each other's tokens; the key is created once; the previous key stays until its tokens expire",
		assumptions: [],
		owner: "L12",
	},
	{
		id: "O38",
		outcome: "Runner routing replaces the old fleet code in @hobo/ci",
		checks: [
			"pnpm exec turbo run test --filter @hobo/ci",
			"test ! -d packages/ci/src/mesh && test ! -d packages/ci/src/fleet",
			"node --import tsx packages/ci/scripts/runner-routing-docs.ts && git diff --exit-code -- site/src/pages/ci",
		],
		threshold: "All pass; regenerating the two site pages leaves no diff",
		assumptions: [],
		owner: "L15",
	},
	{
		id: "O39",
		outcome: "The conformance suites catch broken adapters",
		checks: [vitest("packages/fleet/test/testing/suites.test.ts")],
		threshold:
			"The in-memory doubles pass their suites; each deliberately broken double fails exactly its assertion",
		assumptions: [],
		owner: "L29",
	},
	{
		id: "O40",
		outcome: "Fleet commands refuse what they must",
		checks: [vitest("packages/fleet/test/fleets/commands.test.ts")],
		threshold:
			"One case per refusal of defineFleet, grantSession, submitWork and fleetVerdict; a submission is published once under retry",
		assumptions: [],
		owner: "L32",
	},
	{
		id: "O41",
		outcome: "Local mode needs nothing else",
		checks: [vitest("packages/fleet/test/local/local-fleet.test.ts")],
		threshold:
			"Declared members and fleet are ACTIVE; stable member ids; nothing signed; no socket, fetch or file write outside the temporary directory",
		assumptions: [],
		owner: "L33",
	},
	{
		id: "O42",
		outcome: "The box worker runs as a fleet member with hardened containers",
		checks: [
			vitest(
				"packages/ci-gh-actions/test/fleet-daemon.test.ts",
				"packages/ci-gh-actions/test/container-flags.test.ts",
			),
			"pnpm exec turbo run test --filter @hobo/ci-gh-actions",
		],
		threshold:
			"The daemon composes the agent with DISPATCHER and EXECUTOR; every container is hardened; the package's tests pass",
		assumptions: [],
		owner: "L34",
	},
	{
		id: "O43",
		outcome:
			"The relay's fleet surfaces are read-only calls through the client",
		checks: [
			vitest(
				"packages/ci-gh-actions/test/hosted-control.test.ts",
				"packages/ci-gh-actions/test/relay-mcp.test.ts",
				"packages/ci-gh-actions/test/cloud-events.test.ts",
				"packages/ci-gh-actions/test/mesh-nodes-surfaces.test.ts",
			),
		],
		threshold:
			"The fleet tools and resources answer from a recording fake FleetClient; nothing calls a writing method; the old mesh names are gone; cloud events are typed fleet.*",
		assumptions: [],
		owner: "L35",
	},
	{
		id: "O44",
		outcome: "An order runs only when every acceptance rule holds",
		checks: [vitest("packages/fleet/test/work/order-acceptance.test.ts")],
		threshold:
			"One refusing case per order acceptance rule, including disallowed repositories, refs, workflow digests and regions",
		assumptions: [],
		owner: "L04",
	},
	{
		id: "O45",
		outcome:
			"Overlay join credentials are single use, short-lived and tag-scoped",
		checks: [
			vitest(
				"packages/connectivity/test/minters/minters.test.ts",
				"packages/connectivity/test/minters/minters.pact.test.ts",
			),
		],
		threshold:
			"Each minter asks for a single-use credential with the given expiry and tags; a provider error is unavailable; no log carries the credential; the PACT tests pass",
		fallbackThreshold:
			"The fake-fetch cases pass; the [A13] PACT cases are not run",
		assumptions: ["A13"],
		owner: "L39",
	},
];

const NAMING_COMMANDS = [
	/^pnpm exec vitest run\s/u,
	/^pnpm run test:behavior\s/u,
	/^node\s/u,
	/^docker compose\s/u,
];

/** The files and directories a Check command names, which must exist. */
export function namedFiles(command: string): string[] {
	if (!NAMING_COMMANDS.some((pattern) => pattern.test(command))) return [];
	return command
		.split(/\s+/u)
		.map((token) => token.replace(/^["']|["']$/gu, ""))
		.filter(
			(token) =>
				token.includes("/") &&
				!token.startsWith("-") &&
				!token.startsWith("@") &&
				!token.includes("$") &&
				!token.includes("="),
		);
}

/** Reads `fleet-fallbacks.json` at `root`: the assumption ids whose fallback was taken. */
export function readFallbacks(root: string): string[] {
	const path = join(root, "fleet-fallbacks.json");
	if (!existsSync(path)) return [];
	// SAFETY: the coordinator's fallback record, a JSON array of assumption ids; anything else reads as none.
	const parsed = JSON.parse(readFileSync(path, "utf8")) as readonly string[];
	return Array.isArray(parsed)
		? parsed.filter((id) => /^A\d+$/u.test(String(id))).map(String)
		: [];
}

interface VitestAssertion {
	readonly title?: string;
	readonly fullName?: string;
	readonly status?: string;
}

interface VitestReport {
	readonly testResults?: ReadonlyArray<{
		readonly assertionResults?: readonly VitestAssertion[];
	}>;
}

/** What one vitest JSON report says: totals and the titles of skipped and todo tests. */
export interface VitestTally {
	readonly tests: number;
	readonly failed: number;
	readonly skipped: readonly string[];
}

const SKIPPED = new Set(["skipped", "pending", "todo", "disabled"]);

/** Tallies a vitest JSON report: totals and the titles of skipped and todo tests. */
export function tallyVitest(path: string): VitestTally {
	if (!existsSync(path)) return { tests: 0, failed: 0, skipped: [] };
	// SAFETY: vitest's own JSON reporter output; only assertion titles and statuses are read.
	const report = JSON.parse(readFileSync(path, "utf8")) as VitestReport;
	let tests = 0;
	let failed = 0;
	const skipped: string[] = [];
	for (const file of report.testResults ?? [])
		for (const assertion of file.assertionResults ?? []) {
			tests += 1;
			if (assertion.status === "failed") failed += 1;
			if (SKIPPED.has(assertion.status ?? ""))
				skipped.push(assertion.title ?? assertion.fullName ?? "(untitled)");
		}
	return { tests, failed, skipped };
}

/** Runs a command through bash in `cwd`, streaming its output to stderr. */
export const runInShell: CommandRunner = (command, cwd) => {
	const result = spawnSync("bash", ["-c", command], {
		cwd,
		stdio: ["ignore", 2, 2],
	});
	return result.status ?? 1;
};

/** Runs one outcome against the repository at `root`. */
export function runOutcome(
	spec: OutcomeSpec,
	options: Readonly<{
		root: string;
		fallbacks: readonly string[];
		exec?: CommandRunner;
	}>,
): VerificationRecord {
	const exec = options.exec ?? runInShell;
	const applied = spec.assumptions.filter((id) =>
		options.fallbacks.includes(id),
	);
	const command = spec.checks.join("; ");
	const evidence: string[] = [];
	const measured: Measured = {};
	const record = (pass: boolean): VerificationRecord => ({
		id: spec.id,
		pass,
		command,
		evidence,
		measured,
		fallbacks: applied,
	});
	evidence.push(
		applied.length > 0
			? `threshold (fallback ${applied.join(", ")}): ${spec.fallbackThreshold ?? spec.threshold}`
			: `threshold: ${spec.threshold}`,
	);

	if (spec.deferred !== undefined) {
		evidence.push(
			spec.deferred === "cutover"
				? "checked at cutover, not by this command"
				: "checked when the deferred lane L19 runs",
		);
		return record(false);
	}

	const missing = spec.checks
		.flatMap(namedFiles)
		.filter((path) => !existsSync(join(options.root, path)));
	if (missing.length > 0) {
		for (const path of missing) evidence.push(`missing: ${path}`);
		measured.missing_files = missing.length;
		return record(false);
	}

	const scratch = mkdtempSync(join(tmpdir(), "hobo-fleet-outcome-"));
	let ok = true;
	let tests = 0;
	let skippedCount = 0;
	let commandsRun = 0;
	try {
		for (const [index, check] of spec.checks.entries()) {
			const isVitest = /\bvitest run\b/u.test(check);
			const report = join(scratch, `vitest-${index}.json`);
			const run = isVitest
				? `${check} --reporter=json --outputFile=${report}`
				: check;
			const exitCode = exec(run, options.root);
			commandsRun += 1;
			evidence.push(`exit ${exitCode}: ${check}`);
			if (isVitest) {
				const tally = tallyVitest(report);
				tests += tally.tests;
				for (const title of tally.skipped) {
					const allowed = applied.some((id) => title.startsWith(`[${id}]`));
					if (allowed) {
						evidence.push(`skipped under fallback: ${title}`);
						continue;
					}
					skippedCount += 1;
					ok = false;
					evidence.push(`skipped: ${title}`);
				}
			}
			if (exitCode !== 0) {
				ok = false;
				const rest = spec.checks.length - index - 1;
				if (rest > 0)
					evidence.push(`not run: ${rest} later command(s), after a failure`);
				break;
			}
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	measured.commands_run = commandsRun;
	measured.tests = tests;
	measured.skipped = skippedCount;

	if (ok && spec.measure !== undefined) {
		const threshold = spec.measure(options.root);
		Object.assign(measured, threshold.measured);
		evidence.push(...threshold.evidence);
		ok = threshold.holds;
	}
	return record(ok);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const args = process.argv.slice(2).filter((arg) => arg !== "--");
	const rootArg = args
		.find((arg) => arg.startsWith("--root="))
		?.slice("--root=".length);
	const root = rootArg
		? resolve(rootArg)
		: resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const id = args.find((arg) => !arg.startsWith("--"));
	const spec = OUTCOMES.find((outcome) => outcome.id === id);
	if (spec === undefined) {
		process.stderr.write(
			`usage: fleet:outcome <id> [--root=<dir>]; known ids: ${OUTCOMES.map((outcome) => outcome.id).join(", ")}\n`,
		);
		process.exit(2);
	}
	const result = runOutcome(spec, { root, fallbacks: readFallbacks(root) });
	process.stdout.write(`${JSON.stringify(result)}\n`);
	if (!result.pass) process.exit(1);
}
