import { describe, expect, it } from "vitest";
import {
	ArtifactKind,
	AssemblyRule,
	SubscriptionKind,
} from "../../src/_generated/cd_pb.js";
import {
	HOBO_CI_COMPONENTS,
	hoboCiDogfoodSources,
	hoboSelfDeliverySources,
} from "../../src/compose/ci-bridge.js";

describe("HoBo delivering itself through CD (ci-bridge)", () => {
	it("hoboSelfDeliverySources names the relay and runner-fleet sources HOBO_CI_COMPONENTS declares", () => {
		const sources = hoboSelfDeliverySources({
			ciPipeline: "Hobo-Labs/HoBo",
		});
		expect(sources.map((source) => [source.name, source.bindle])).toEqual([
			[HOBO_CI_COMPONENTS.relay.source, HOBO_CI_COMPONENTS.relay.bindle],
			[
				HOBO_CI_COMPONENTS.runnerFleet.source,
				HOBO_CI_COMPONENTS.runnerFleet.bindle,
			],
		]);
	});

	it("reads the relay bundle from passing HoBo CI runs", () => {
		const [relay] = hoboSelfDeliverySources({
			ciPipeline: "Hobo-Labs/HoBo",
		});
		expect(relay?.assembly).toBe(AssemblyRule.INDEPENDENT);
		expect(relay?.subscriptions).toHaveLength(1);
		const [subscription] = relay?.subscriptions ?? [];
		expect(subscription?.kind).toBe(SubscriptionKind.HOBO_CI);
		expect(subscription?.locator).toBe("Hobo-Labs/HoBo");
		expect(subscription?.artifactName).toBe("relay/bundle");
		expect(subscription?.artifactKind).toBe(ArtifactKind.FUNCTION_BUNDLE);
	});

	it("keeps HOBO_CI_COMPONENTS: the relay is the hobo-ci-relay Bindle, source and pipeline", () => {
		expect(HOBO_CI_COMPONENTS.relay).toEqual({
			bindle: "hobo-ci-relay",
			source: "hobo-ci-relay",
			pipeline: "hobo-ci-relay",
		});
		expect(Object.isFrozen(HOBO_CI_COMPONENTS.relay)).toBe(true);
	});

	it("keeps the former name as a deprecated alias of hoboSelfDeliverySources", () => {
		expect(hoboCiDogfoodSources).toBe(hoboSelfDeliverySources);
	});
});
