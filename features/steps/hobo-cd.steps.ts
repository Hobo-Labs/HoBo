/**
 * Cucumber steps for features/hobo-cd-*.feature (plan 0024 WP20).
 *
 * Journeys run on the deterministic journey model (hobo-cd-journey-model.ts);
 * fleet journeys on the conformance kit's reference placement and fan-out
 * plus the failover and Rail models (hobo-cd-fleet-model.ts); conformance,
 * matrix and chaos scenarios run the @hobo/conformance suites against the
 * kit's reference adapters. All offline: no network, wall clock or RNG on a
 * decision path. Step texts are CD-specific so they cannot collide with other
 * features loaded by the `test:behavior` lane.
 */
import assert from "node:assert/strict";
import { Before, Given, Then, When } from "@cucumber/cucumber";
import {
	type CdConformanceReport,
	runAirgapConformance,
	runArtifactStoreConformance,
	runArtifactVerifierConformance,
	runCampInventoryConformance,
	runCdChaos,
	runFanoutControllerConformance,
	runHealthSourceConformance,
	runJournalReplayConformance,
	runPlacementEngineConformance,
	runPlatformMatrix,
	runPostureEvaluatorConformance,
	runProvenanceVerifierConformance,
	runPublisherConformance,
	runRealizerConformance,
	runReconcilerTransportConformance,
	runSubscriptionDriverConformance,
	runToolsetMatrix,
	runTrafficShifterConformance,
	type ScenarioCamp,
} from "../../packages/conformance/src/index.js";
import {
	refAirgapHarness,
	refArtifactVerifierHarness,
	refChaosHarness,
	refFanoutHarness,
	refHealthHarness,
	refInventoryHarness,
	refPlacementHarness,
	refPlatformHarness,
	refPostureHarness,
	refProvenanceHarness,
	refPublisherHarness,
	refRealizerHarness,
	refReplayHarness,
	refStoreHarness,
	refSubscriptionHarness,
	refToolsetHarness,
	refTrafficHarness,
	refTransportHarness,
	referenceDecide,
	referenceFanout,
} from "../../examples/cd-conformance-kit/src/index.js";
import { FailoverModel, type FailoverCamp, RailModel, retailFleet, rollOutToFleet, type FleetRun } from "./hobo-cd-fleet-model.js";
import { compareCanary, DeliveryModel, GitOpsPublisher, type PromotionResult, Previews, type Sensitivity, StagedRollout } from "./hobo-cd-journey-model.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const HOTFIX_MAX_MS = 72 * HOUR;
const HUMAN = { id: "alice", kind: "human" } as const;
const AGENT = { id: "agent:release-bot", kind: "agent" } as const;

type CdState = {
	model: DeliveryModel;
	last?: PromotionResult;
	lastRefusal?: string;
	lastFreight?: string;
	verdict?: "PASS" | "FAIL";
	canary?: string;
	rollout?: StagedRollout;
	previews: Previews;
	preview?: string;
	publisher?: GitOpsPublisher;
	revision?: string;
	fleet?: ScenarioCamp[];
	offline: Set<string>;
	fleetRun?: FleetRun;
	caughtUp: string[];
	failoverCamps: FailoverCamp[];
	workload?: string;
	dataInCamp: Set<string>;
	failover?: FailoverModel;
	rail?: RailModel;
	gateEffect?: "allow" | "deny";
	imported: ScenarioCamp[];
	report?: CdConformanceReport<string>;
	freightIds?: readonly string[];
	fault?: string;
};

let s: CdState;

function fresh(): CdState {
	return { model: new DeliveryModel(), previews: new Previews(), offline: new Set(), caughtUp: [], failoverCamps: [], dataInCamp: new Set(), imported: [] };
}

Before({ tags: "@hobo-cd" }, () => {
	s = fresh();
});

const camp = (node: string) => `camp-${node}`;

function ensureRecorded(freight: string): void {
	if (!s.model.freight.has(freight)) s.model.record(freight);
	s.lastFreight = freight;
}

function upstreamOf(node: string): string | undefined {
	return s.model.nodes.get(node)?.upstream;
}

function qualifyChainTo(freight: string, node: string): void {
	for (let up = upstreamOf(node); up !== undefined; up = upstreamOf(up)) s.model.qualified.set(`${freight}@${up}`, s.model.now);
}

function promoteHuman(freight: string, node: string): void {
	s.last = s.model.promote(freight, node, HUMAN);
	if (s.last.status === "refused") s.lastRefusal = s.last.code;
}

// ── Journeys ─────────────────────────────────────────────────────────────────

Given("a CD pipeline dev → staging → prod", () => {
	s.model.node("dev", camp("dev"));
	s.model.node("staging", camp("staging"), "dev");
	s.model.node("prod", camp("prod"), "staging", 0, "prod-hours");
});

Given("Freight {string} is recorded", (freight: string) => ensureRecorded(freight));

When("a human promotes {string} to {string}", (freight: string, node: string) => {
	ensureRecorded(freight);
	promoteHuman(freight, node);
});

Then("the promotion is refused with {string}", (code: string) => {
	assert.equal(s.lastRefusal, code);
});

When("{string} is promoted to {string} and verifies PASS", (freight: string, node: string) => {
	ensureRecorded(freight);
	promoteHuman(freight, node);
	assert.equal(s.last?.status, "promoted");
	assert.ok(s.model.qualify(freight, node, "PASS"));
});

Then("the {string} Camp runs {string}", (node: string, freight: string) => {
	assert.equal(s.model.current(camp(node)), freight);
});

Given("{string} runs in {string}", (freight: string, node: string) => {
	ensureRecorded(freight);
	qualifyChainTo(freight, node);
	promoteHuman(freight, node);
	assert.equal(s.last?.status, "promoted");
});

Given("Freight {string} is promoted to {string} as a canary", (freight: string, node: string) => {
	ensureRecorded(freight);
	qualifyChainTo(freight, node);
	promoteHuman(freight, node);
	assert.equal(s.last?.status, "promoted");
	s.canary = freight;
});

const BASELINE = [0.01, 0.012, 0.011, 0.009, 0.013, 0.01, 0.012, 0.011];

function verifyCanary(node: string, canary: readonly number[], sensitivity: Sensitivity): void {
	s.verdict = compareCanary(canary, BASELINE, sensitivity);
	const freight = s.canary ?? "";
	if (s.verdict === "PASS") s.model.qualify(freight, node, "PASS");
	else s.model.rollback(camp(node));
}

When("the canary error rate is significantly worse than baseline at {word} sensitivity", (sensitivity: Sensitivity) => {
	verifyCanary("staging", [0.05, 0.06, 0.07, 0.055, 0.065, 0.058, 0.062, 0.071], sensitivity);
});

When("the canary error rate matches baseline at {word} sensitivity", (sensitivity: Sensitivity) => {
	verifyCanary("staging", [0.011, 0.01, 0.012, 0.01, 0.012, 0.009, 0.013, 0.011], sensitivity);
});

When("the health source returns no canary data", () => {
	verifyCanary("staging", [], "MEDIUM");
});

Then("canary verification is {word}", (verdict: string) => {
	assert.equal(s.verdict, verdict);
});

Then("the {string} Camp rolls back to {string}", (node: string, freight: string) => {
	assert.equal(s.model.current(camp(node)), freight);
	assert.ok(s.model.journal.some((line) => line.startsWith(`env.PromoteRolledBack ${camp(node)}`)));
});

Then("{string} is not qualified in {string}", (freight: string, node: string) => {
	assert.equal(s.model.qualified.has(`${freight}@${node}`), false);
});

Then("{string} is qualified in {string}", (freight: string, node: string) => {
	assert.equal(s.model.qualified.has(`${freight}@${node}`), true);
});

Given("{string} has passed verification in {string}", (freight: string, node: string) => {
	ensureRecorded(freight);
	s.model.qualified.set(`${freight}@${node}`, s.model.now);
});

Given("a canary rollout of {string} in {string} behind window {string}", (freight: string, node: string, window: string) => {
	ensureRecorded(freight);
	assert.equal(s.model.nodes.get(node)?.window, window);
	s.rollout = new StagedRollout(s.model, window);
});

Given("the rollout has reached {int} percent", (percent: number) => {
	for (let i = 0; i < 8 && s.rollout?.percent !== percent; i += 1) s.rollout?.boundary();
	assert.equal(s.rollout?.percent, percent);
});

When("window {string} freezes", (window: string) => {
	s.model.freezes.set(window, true);
});

When("window {string} opens again", (window: string) => {
	s.model.freezes.set(window, false);
});

When("the rollout reaches its next stage boundary", () => s.rollout?.boundary());

When("the rollout reaches {int} more stage boundaries", (n: number) => {
	for (let i = 0; i < n; i += 1) s.rollout?.boundary();
});

Then("the rollout holds at {int} percent", (percent: number) => {
	assert.equal(s.rollout?.held, true);
	assert.equal(s.rollout?.percent, percent);
});

Then("the rollout is at {int} percent", (percent: number) => {
	assert.equal(s.rollout?.percent, percent);
	assert.equal(s.rollout?.held, false);
});

Then("the promotion is awaiting its window", () => {
	assert.equal(s.last?.status, "awaiting-window");
	assert.equal(s.model.current(camp("prod")), undefined);
});

When("an operator approves {string} for {string} for {int} hours", (freight: string, node: string, hours: number) => {
	assert.ok(s.model.approve(freight, node, hours * HOUR, HOTFIX_MAX_MS));
});

Then("an approval for {int} hours is refused", (hours: number) => {
	assert.equal(s.model.approve(s.lastFreight ?? "", "prod", hours * HOUR, HOTFIX_MAX_MS), false);
});

When("{int} hours pass", (hours: number) => {
	s.model.now += hours * HOUR;
});

When("the {string} target drifts from its desired Set", (node: string) => {
	s.model.drift.add(camp(node));
});

Then("the reconciler remediates the drift by re-applying the Set", () => {
	assert.equal(s.model.reconcile(camp("prod")), "remediated");
	assert.equal(s.model.reconcile(camp("prod")), "converged");
});

When("an agent promotes {string} to {string}", (freight: string, node: string) => {
	ensureRecorded(freight);
	s.last = s.model.promote(freight, node, AGENT);
});

Then("a proposal is recorded and nothing is applied to {string}", (node: string) => {
	assert.equal(s.last?.status, "proposed");
	assert.equal(s.model.current(camp(node)), undefined);
});

Then("the proposing agent cannot approve the proposal", () => {
	assert.equal(s.last?.status, "proposed");
	const id = s.last?.status === "proposed" ? s.last.proposalId : "";
	assert.equal(s.model.approveProposal(id, AGENT), false);
});

Then("a different human can approve the proposal", () => {
	const id = s.last?.status === "proposed" ? s.last.proposalId : "";
	assert.equal(s.model.approveProposal(id, HUMAN), true);
});

When("the drift is adopted as desired state {string}", (freight: string) => {
	s.model.adoptDrift(camp("prod"), freight);
});

Then("reconciling {string} converges without remediation", (node: string) => {
	assert.equal(s.model.reconcile(camp(node)), "converged");
	assert.equal(s.model.journal.some((line) => line.includes("drift-remediate")), false);
});

Given("a preview of {string} with a TTL of {int} hour(s)", (freight: string, hours: number) => {
	s.preview = `preview-${freight}`;
	s.previews.create(s.preview, s.model.now, hours * HOUR);
});

When("{int} minutes pass", (minutes: number) => {
	s.model.now += minutes * MINUTE;
});

When("{int} more minute(s) pass(es)", (minutes: number) => {
	s.model.now += minutes * MINUTE;
});

Then("the preview is live", () => {
	assert.deepEqual(s.previews.expire(s.model.now), []);
	assert.ok(s.previews.live.has(s.preview ?? ""));
});

Then("the preview has expired and is removed", () => {
	assert.deepEqual(s.previews.expire(s.model.now), [s.preview]);
	assert.equal(s.previews.live.size, 0);
});

Given("a GitOps publisher for {string}", (_node: string) => {
	s.publisher = new GitOpsPublisher();
});

When("the desired Set is published", () => {
	s.revision = s.publisher?.publish("set-prod-1", "resolved set");
});

Then("the Camp is converging, not converged", () => {
	assert.equal(s.publisher?.observe(s.revision ?? ""), "CONVERGING");
});

When("the GitOps engine syncs the published revision", () => {
	if (s.publisher) s.publisher.synced = s.revision;
});

Then("the Camp is converged", () => {
	assert.equal(s.publisher?.observe(s.revision ?? ""), "CONVERGED");
});

// ── Fleet and policy ─────────────────────────────────────────────────────────

Given("a retail edge fleet of {int} Camps across {int} regions", (count: number, regions: number) => {
	s.fleet = retailFleet(count);
	assert.equal(new Set(s.fleet.map((c) => c.regions[0])).size, regions);
});

Given("{int} stores are offline", (n: number) => {
	for (const id of ["store-101", "store-202", "store-303"].slice(0, n)) s.offline.add(id);
});

When("Freight {string} fans out with a mandatory pilot group of {int} and concurrency {int}", async (_freight: string, pilot: number, concurrency: number) => {
	s.fleetRun = await rollOutToFleet(s.fleet ?? [], s.offline, pilot, concurrency);
});

Then("the fan-out completes", () => {
	assert.equal(s.fleetRun?.status.state, 3);
});

Then("no more than {int} Camps were ever in flight", (n: number) => {
	assert.ok((s.fleetRun?.maxInFlight ?? Number.POSITIVE_INFINITY) <= n);
});

Then("the pilot group finished before any other store started", () => {
	const order = s.fleetRun?.decision.groups.flatMap((g) => g.campIds) ?? [];
	const pilot = new Set(order.slice(0, 8));
	assert.deepEqual(new Set(s.fleetRun?.started.slice(0, 8)), pilot);
});

Then("the {int} offline stores are deferred, not failed", (n: number) => {
	assert.equal(s.fleetRun?.status.failed.length, 0);
	assert.deepEqual([...(s.fleetRun?.status.deferred ?? [])].sort(), [...s.offline].sort());
	assert.equal(s.fleetRun?.status.deferred.length, n);
});

When("the offline stores recover", async () => {
	const late = [...s.offline].sort();
	const world = referenceFanout({ camps: late, groups: [{ name: "late-entry", campIds: late, mandatory: false }], strategy: 2, maxConcurrency: 40, maxFailures: 0, outcomes: Object.fromEntries(late.map((id) => [id, "succeed"])) });
	for (let i = 0; i < 4; i += 1) await world.tick();
	s.caughtUp = [...(await world.status()).succeeded];
});

Then("they catch up to {string}", (_freight: string) => {
	assert.deepEqual([...s.caughtUp].sort(), [...s.offline].sort());
});

function failoverCamp(campId: string, provider: string, region: string): FailoverCamp {
	return { campId, provider, region, jurisdiction: region.startsWith("eu-") ? "EU" : "US" };
}

Given(
	"Camps {string} on {word} {word}, {string} on {word} {word} and {string} on {word} {word}",
	(a: string, ap: string, ar: string, b: string, bp: string, br: string, c: string, cp: string, cr: string) => {
		s.failoverCamps = [failoverCamp(a, ap, ar), failoverCamp(b, bp, br), failoverCamp(c, cp, cr)];
	},
);

Given("the workload runs on {string} under EU residency", (campId: string) => {
	s.workload = campId;
});

Given("the workload and its database run on {string} under EU residency", (campId: string) => {
	s.workload = campId;
	s.dataInCamp.add(campId);
});

Given("the Rail permits automatic failover with max_concurrent {int}", (maxConcurrent: number) => {
	s.failover = new FailoverModel(s.failoverCamps, { automatic: true, maxConcurrent, requiredSignals: 2 }, "EU", s.dataInCamp);
	s.failover.placedOn.add(s.workload ?? "");
});

When("the reconciler alone reports {string} unreachable", (campId: string) => {
	for (let i = 0; i < 100; i += 1) {
		s.failover?.signal(campId, "reconciler");
		s.failover?.tick();
	}
});

Then("no failover is proposed", () => {
	assert.deepEqual(s.failover?.events, []);
});

When("the Station and a health source both observe {string} down", (campId: string) => {
	s.failover?.signal(campId, "station");
	s.failover?.signal(campId, "health-source");
	s.failover?.tick();
	s.failover?.tick();
});

Then("one failover from {string} to {string} runs", (from: string, to: string) => {
	const replacing = s.failover?.events.filter((e) => e.kind === "replacing") ?? [];
	assert.deepEqual(replacing, [{ kind: "replacing", from, to }]);
	assert.ok((s.failover?.inFlight ?? 0) <= 1);
});

Then("the source is kept until the replacement qualifies", () => {
	assert.equal(s.failover?.purged.size, 0);
	assert.ok(s.failover?.placedOn.has(s.workload ?? ""));
});

When("the replacement qualifies", () => {
	s.failover?.qualify(s.workload ?? "");
});

Then("traffic shifts and the source is purged", () => {
	const kinds = s.failover?.events.map((e) => e.kind) ?? [];
	assert.deepEqual(kinds.slice(-3), ["qualified", "shifted", "purged"]);
});

When("{string} recovers", (campId: string) => {
	s.failover?.recover(campId);
	s.failover?.tick();
});

Then("nothing fails back automatically", () => {
	assert.equal(s.failover?.placedOn.has(s.workload ?? ""), false);
	assert.equal(s.failover?.events.filter((e) => e.kind === "replacing").length, 1);
});

When("an operator taints {string} NO_RUN", (campId: string) => {
	s.failover?.signal(campId, "operator");
	s.failover?.tick();
});

Then("the failover is refused as {string} naming a Trails handover", (code: string) => {
	const refused = s.failover?.events.find((e) => e.kind === "refused");
	assert.ok(refused?.detail?.startsWith(code));
	assert.match(refused?.detail ?? "", /Trails/);
	assert.equal(s.failover?.events.some((e) => e.kind === "replacing"), false);
});

const railDecide = (rail: string, delta: string): "allow" | "deny" => (rail === "rail-v2" && delta === "public-bucket" ? "deny" : "allow");

Given("Camps enforce Rail {string} which allows public buckets", (rail: string) => {
	s.rail = new RailModel(rail, railDecide);
});

Given("Rail {string} which denies public buckets is bound INFORM", (rail: string) => {
	s.rail?.bindInform(rail);
});

When("a Delta creating a public bucket reaches the gate", () => {
	s.gateEffect = s.rail?.gate("public-bucket");
});

Then("{string} decides and the Delta is allowed", (rail: string) => {
	assert.equal(s.rail?.enforced, rail);
	assert.equal(s.gateEffect, "allow");
});

Then("a shadow divergence is recorded for {string}", (_rail: string) => {
	assert.equal(s.rail?.shadow.at(-1)?.diverged, true);
	assert.equal(s.rail?.shadow.at(-1)?.candidate, "deny");
});

When("{string} is promoted to ENFORCE before its INFORM node qualifies", (rail: string) => {
	const outcome = s.rail?.enforce(rail);
	assert.ok(outcome && !outcome.ok);
	s.lastRefusal = outcome.code;
});

When("the INFORM node verifies with {int} percent noncompliant and {int} declared divergence(s)", (percent: number, divergences: number) => {
	assert.equal(s.rail?.verifyInform(percent / 100, divergences), "PASS");
});

When("{string} is promoted to ENFORCE", (rail: string) => {
	assert.equal(s.rail?.enforce(rail).ok, true);
});

Then("{string} is the enforced Rail", (rail: string) => {
	assert.equal(s.rail?.enforced, rail);
	assert.equal(s.rail?.candidate, undefined);
});

Then("a Delta creating a public bucket is denied", () => {
	assert.equal(s.rail?.gate("public-bucket"), "deny");
});

Given("{int} Camps imported from ClusterProfiles", (n: number) => {
	s.imported = Array.from({ length: n }, (_, i) => ({
		campId: `cp-${i + 1}`,
		yard: "yard-kube",
		provider: "kubernetes",
		regions: ["eu-west"],
		labels: { source: "clusterprofile" },
		management: "OBSERVE_ONLY" as const,
	}));
});

function placeImported() {
	const outcome = referenceDecide({ camps: s.imported, scores: [], placement: { count: 0 }, nowMs: 0 }, s.imported.map((c) => c.campId));
	assert.ok(outcome.ok);
	return outcome.value;
}

Then("they are OBSERVE_ONLY and placement excludes them", () => {
	assert.ok(s.imported.every((c) => c.management === "OBSERVE_ONLY"));
	const decision = placeImported();
	assert.ok(decision.candidates.every((c) => !c.selected && c.exclusionCodes.includes("observe-only")));
});

Then("reconciling them only observes and never applies", () => {
	// D5: OBSERVE_ONLY reads, reports and evaluates posture; it never applies.
	const applies = s.imported.filter((c) => c.management !== "OBSERVE_ONLY").length;
	assert.equal(applies, 0);
});

When("an operator promotes {string} to MANAGED", (campId: string) => {
	s.imported = s.imported.map((c) => (c.campId === campId ? { ...c, management: "MANAGED" as const } : c));
});

Then("placement includes {string} only", (campId: string) => {
	const decision = placeImported();
	assert.deepEqual(decision.candidates.filter((c) => c.selected).map((c) => c.campId), [campId]);
});

// ── Conformance, matrices, chaos ─────────────────────────────────────────────

type Runner = (mutant?: string) => Promise<CdConformanceReport<string>>;

/** Narrow a feature-table string to one of a factory's declared mutants. */
function pick<T extends string>(allowed: readonly T[], mutant: string | undefined): T | undefined {
	return allowed.find((candidate) => candidate === mutant);
}

const SUITES = new Map<string, Runner>([
	["Realizer", (m) => runRealizerConformance(refRealizerHarness(pick(["trusts-provider", "reapplies", "ignores-abort", "untyped-failure"], m)))],
	["TrafficShifter", (m) => runTrafficShifterConformance(refTrafficHarness(pick(["claims-full-without-capability", "forgets-status"], m)))],
	["HealthSource", (m) => runHealthSourceConformance(refHealthHarness(pick(["fabricates-on-empty", "ignores-cohort"], m)))],
	["PublisherPort", (m) => runPublisherConformance(refPublisherHarness(pick(["converged-on-publish", "writes-every-time"], m)))],
	["ReconcilerTransport", (m) => runReconcilerTransportConformance(refTransportHarness(pick(["no-fencing", "replays-checkpointed"], m)))],
	["ArtifactStore", (m) => runArtifactStoreConformance(refStoreHarness(pick(["no-verify-on-read", "duplicate-listing"], m)))],
	["ArtifactVerifier", (m) => runArtifactVerifierConformance(refArtifactVerifierHarness(pick(["passes-unreachable", "rewrites-digest"], m)))],
	["ProvenanceVerifier", (m) => runProvenanceVerifierConformance(refProvenanceHarness(pick(["skips-signer-pin", "skips-subject-binding", "throws-on-garbage"], m)))],
	["SubscriptionDriver", (m) => runSubscriptionDriverConformance(refSubscriptionHarness(pick(["ignores-cursor", "ignores-limit", "unpinned"], m)))],
	["PlacementEngine", (m) => runPlacementEngineConformance(refPlacementHarness(pick(["order-sensitive", "claims-grant", "extrapolates-scores"], m)))],
	["FanoutController", (m) => runFanoutControllerConformance(refFanoutHarness(pick(["unbounded", "defer-as-failure", "eager-groups", "non-idempotent"], m)))],
	["PostureEvaluator", (m) => runPostureEvaluatorConformance(refPostureHarness(pick(["unknown-passes", "unbounded-observed"], m)))],
	["CampInventory", (m) => runCampInventoryConformance(refInventoryHarness(pick(["agent-no-run", "order-digest", "accepts-agent-no-run"], m)))],
]);

function suite(name: string): Runner {
	const runner = SUITES.get(name);
	assert.ok(runner, `no CD suite named ${name}`);
	return runner;
}

const failures = (report: CdConformanceReport<string> | undefined) => report?.failures.map((f) => `${f.assertion}: ${f.detail}`) ?? ["no report"];

When("the {string} conformance suite runs against its reference adapter", async (name: string) => {
	s.report = await suite(name)();
});

When("the {string} conformance suite runs against the {string} mutant", async (name: string, mutant: string) => {
	assert.ok(mutant.length > 0);
	const report = await suite(name)(mutant);
	assert.ok(report.subject.includes(`[${mutant}]`), `mutant ${mutant} is not declared for ${name}`);
	s.report = report;
});

Then("every assertion passes", () => {
	assert.deepEqual(failures(s.report), []);
});

Then("assertion {string} fails", (assertion: string) => {
	assert.ok(s.report?.failures.some((f) => f.assertion === assertion), `expected ${assertion} to fail; failures: ${failures(s.report).join("; ")}`);
});

When(
	"one build arrives through OCI polling, Git polling, GitHub OIDC push, GitLab OIDC push, an in-toto attestation, a CDEvent nudge and HoBo CI",
	async () => {
		const report = await runToolsetMatrix(refToolsetHarness());
		s.report = report;
		s.freightIds = Object.values(report.freightIds);
	},
);

Then("every path yields the same Freight id", () => {
	assert.equal(s.freightIds?.length, 7);
	assert.equal(new Set(s.freightIds).size, 1);
	assert.equal(s.report?.assertions.sameFreightIdAcrossPaths, "pass");
});

Then("a CDEvent payload alone creates no Freight", () => {
	assert.equal(s.report?.assertions.payloadAloneCreatesNoFreight, "pass");
});

When("one Freight is delivered across every traffic rung and none, every artifact kind, a built-in and a WASM-component resolver", async () => {
	s.report = await runPlatformMatrix(refPlatformHarness());
});

Then("every cell converges with the Freight's digests or refuses as {string}", (_code: string) => {
	assert.deepEqual(failures(s.report), []);
	assert.equal(Object.keys(s.report?.assertions ?? {}).length, 84);
});

When("an air-gapped Yard promotes through a local source and an agent", async () => {
	s.report = await runAirgapConformance(refAirgapHarness());
});

Then("the Camp converges with no egress beyond the Yard", () => {
	assert.equal(s.report?.assertions.promotesViaLocalSourceAndAgent, "pass");
	assert.equal(s.report?.assertions.noEgressBeyondTheYard, "pass");
});

Then("the Station never dials the agent", () => {
	assert.equal(s.report?.assertions.stationNeverDialsTheAgent, "pass");
	assert.equal(s.report?.assertions.stationHoldsNoTargetCredential, "pass");
});

When("a full pipeline run is replayed from its journal", async () => {
	s.report = await runJournalReplayConformance(refReplayHarness());
});

Then("the replayed state is identical to the live state", () => {
	assert.deepEqual(failures(s.report), []);
});

When("chaos fault {string} is injected, held and healed", async (fault: string) => {
	s.fault = fault;
	s.report = await runCdChaos(refChaosHarness());
});

Then("its invariants hold throughout and the system converges", () => {
	const report = s.report;
	assert.ok(report);
	assert.equal(report.assertions[`${s.fault}:invariants`], "pass");
	assert.equal(report.assertions[`${s.fault}:recovers`], "pass");
});
