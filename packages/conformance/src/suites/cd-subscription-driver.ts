// SubscriptionDriver conformance (plan 0024 D3, I15). Pull discovery is a
// verified read, forward-only from a high-water mark, bounded per poll, and
// an outage is a typed refusal that leaves the cursor where it was.
import {
	abortedSignal,
	type CdConformanceReport,
	type CdSuiteOptions,
	check,
	checkSecretFree,
	checkTypedRefusal,
	runCdAssertions,
	SHA256_DIGEST,
} from "./cd-kit.js";
import type {
	DiscoveredArtifactLike,
	Outcome,
	SubscriptionDriverLike,
} from "./cd-shapes.js";

// public-contract: versioned conformance suite id stamped on CD conformance reports.
export const SUBSCRIPTION_DRIVER_SUITE = "hobo.cd.subscription-driver/v1";

// public-contract: assertion names of the SubscriptionDriver suite.
export const SUBSCRIPTION_DRIVER_ASSERTIONS = Object.freeze([
	"kindIsDeclared",
	"discoveredArtifactsAreDigestPinned",
	"discoveryIsForwardOnly",
	"unchangedSourceYieldsNothing",
	"discoveryLimitIsRespected",
	"outageIsTypedRefusal",
	"discoveryIsDeterministic",
	"abortIsHonoured",
	"resultsAreSecretFree",
] as const);
export type SubscriptionDriverAssertion =
	(typeof SUBSCRIPTION_DRIVER_ASSERTIONS)[number];

export interface SubscriptionSourceWorld<TSub, TCtx> {
	driver: SubscriptionDriverLike<TSub, TCtx>;
	/** Publish a new version at the source (registry push, Git commit, CI run). */
	release(version: string): Promise<void>;
	/** Make the source refuse every request until healed. */
	outage(down: boolean): void;
}

export interface SubscriptionDriverHarness<TSub, TCtx> {
	readonly subject: string;
	readonly expectedKind: number;
	readonly source: string;
	/** A source holding `versions`, oldest first. */
	create(
		versions: readonly string[],
	): Promise<SubscriptionSourceWorld<TSub, TCtx>>;
	/** The subscription under test with the given discovery limit. */
	subscription(limit: number): TSub;
	/** A version string newer than every one passed to `create`. */
	newer(index: number): string;
	ctx(): TCtx;
}

type Discovery = Outcome<
	Readonly<{ artifacts: readonly DiscoveredArtifactLike[]; cursor: string }>
>;

export async function runSubscriptionDriverConformance<TSub, TCtx>(
	harness: SubscriptionDriverHarness<TSub, TCtx>,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<SubscriptionDriverAssertion>> {
	const versions = [harness.newer(0), harness.newer(1), harness.newer(2)];
	const discover = (
		world: SubscriptionSourceWorld<TSub, TCtx>,
		limit: number,
		cursor?: string,
		signal: AbortSignal = new AbortController().signal,
	): Promise<Discovery> =>
		world.driver.discover(
			cursor === undefined
				? {
						source: harness.source,
						subscription: harness.subscription(limit),
						signal,
					}
				: {
						source: harness.source,
						subscription: harness.subscription(limit),
						cursor,
						signal,
					},
			harness.ctx(),
		);
	const ok = (outcome: Discovery) => {
		check(
			outcome.ok,
			"discovery against a healthy source was refused",
			"read the source and report what is there",
		);
		if (!outcome.ok) throw new Error("refused");
		return outcome.value;
	};
	return runCdAssertions<SubscriptionDriverAssertion>(
		SUBSCRIPTION_DRIVER_SUITE,
		harness.subject,
		{
			kindIsDeclared: async () => {
				const world = await harness.create(versions);
				check(
					world.driver.kind === harness.expectedKind,
					`kind ${world.driver.kind} is not ${harness.expectedKind}`,
					"declare the SubscriptionKind served",
				);
			},
			discoveredArtifactsAreDigestPinned: async () => {
				const world = await harness.create(versions);
				const found = ok(await discover(world, 20));
				check(
					found.artifacts.length > 0,
					"nothing discovered at a populated source",
					"discover the source's versions",
				);
				for (const item of found.artifacts) {
					check(
						item.source === harness.source,
						`artifact names source ${item.source}`,
						"echo the source name",
					);
					check(
						SHA256_DIGEST.test(item.artifact?.digest ?? ""),
						`artifact ${item.version} has no sha256 digest`,
						"pin every discovery to a digest read from the source (I15)",
					);
				}
			},
			discoveryIsForwardOnly: async () => {
				const world = await harness.create(versions);
				const first = ok(await discover(world, 20));
				const seen = new Set(
					first.artifacts.map((item) => item.artifact?.digest),
				);
				await world.release(harness.newer(3));
				const second = ok(await discover(world, 20, first.cursor));
				check(
					second.artifacts.length >= 1,
					"a new version after the cursor was not discovered",
					"discover what arrived after the high-water mark",
				);
				check(
					second.artifacts.every((item) => !seen.has(item.artifact?.digest)),
					"discovery repeated an artifact before the cursor",
					"discovery is forward-only from the high-water mark (D3)",
				);
			},
			unchangedSourceYieldsNothing: async () => {
				const world = await harness.create(versions);
				const first = ok(await discover(world, 20));
				const again = ok(await discover(world, 20, first.cursor));
				check(
					again.artifacts.length === 0,
					`an unchanged source yielded ${again.artifacts.length} artifact(s)`,
					"nothing new after the cursor means nothing discovered",
				);
			},
			discoveryLimitIsRespected: async () => {
				const world = await harness.create(versions);
				const found = ok(await discover(world, 1));
				check(
					found.artifacts.length <= 1,
					`limit 1 yielded ${found.artifacts.length}`,
					"respect discovery_limit per poll",
				);
			},
			outageIsTypedRefusal: async () => {
				const world = await harness.create(versions);
				const before = ok(await discover(world, 20));
				world.outage(true);
				await world.release(harness.newer(3));
				checkTypedRefusal(
					await discover(world, 20, before.cursor),
					"discovery during a source outage",
				);
				world.outage(false);
				const after = ok(await discover(world, 20, before.cursor));
				check(
					after.artifacts.length >= 1,
					"the version released during the outage was lost",
					"an outage leaves the cursor in place; resume after it heals",
				);
			},
			discoveryIsDeterministic: async () => {
				const a = ok(await discover(await harness.create(versions), 20));
				const b = ok(await discover(await harness.create(versions), 20));
				const digests = (found: typeof a) =>
					found.artifacts.map((item) => item.artifact?.digest).join(",");
				check(
					digests(a) === digests(b) && a.cursor === b.cursor,
					"two discoveries of one source disagree",
					"discovery is deterministic over the same source state (I8)",
				);
			},
			abortIsHonoured: async () => {
				const world = await harness.create(versions);
				let outcome: Discovery | undefined;
				try {
					outcome = await discover(world, 20, undefined, abortedSignal());
				} catch {
					outcome = undefined;
				}
				check(
					outcome === undefined || !outcome.ok,
					"an aborted discovery returned artifacts",
					"check the signal before each request",
				);
			},
			resultsAreSecretFree: async () => {
				const world = await harness.create(versions);
				checkSecretFree(await discover(world, 20), "the discovery");
				world.outage(true);
				checkSecretFree(await discover(world, 20), "the outage refusal");
			},
		},
		options,
	);
}
