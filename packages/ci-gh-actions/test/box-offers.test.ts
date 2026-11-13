import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	AccountSchema,
	type Configuration,
	ConfigurationSchema,
	OfferSchema,
} from "@hobo/ci";
import { describe, expect, it } from "vitest";
import {
	applyCommittedBoxProviders,
	readCommittedBoxProviders,
} from "../src/isolated-worker/box-offers.js";
import {
	boxFleetLabels,
	DEFAULT_RUNNER_ROUTING,
} from "../src/isolated-worker/box-routing-policy.js";

const repoRoot = new URL("../../../", import.meta.url).pathname;
const daemon = readFileSync(
	new URL("../scripts/isolated-worker-daemon-main.mts", import.meta.url),
	"utf8",
);

type ProjectDocument = Readonly<{
	environments: Readonly<
		Record<
			string,
			Readonly<{
				policy: { providers: readonly { id: string; kind: string }[] };
			}>
		>
	>;
}>;

function checkout(document: ProjectDocument): string {
	const root = mkdtempSync(join(tmpdir(), "box-offers-"));
	mkdirSync(join(root, ".hobo"));
	writeFileSync(join(root, ".hobo", "ci.json"), JSON.stringify(document));
	return root;
}

function configuration(
	offers: readonly Partial<{
		id: string;
		provider: string;
		providerAccountId: string;
		runsOn: string;
		enabled: boolean;
		backend: string;
	}>[],
): Configuration {
	return create(ConfigurationSchema, {
		accounts: [
			create(AccountSchema, {
				id: "hobo-labs",
				offers: offers.map((offer) =>
					create(OfferSchema, {
						provider: "hobo-box-worker",
						backend: "isolated-container",
						providerAccountId: "oracle-free-vm",
						enabled: true,
						concurrency: 2,
						...offer,
					}),
				),
			}),
		],
	});
}

describe("the box's offers take routing from committed configuration (plan 0026, R2)", () => {
	it("reads the committed box provider for this box from .hobo/ci.json", () => {
		expect(readCommittedBoxProviders(repoRoot, "oracle-free-vm")).toEqual([
			{
				id: "oracle-free-isolated",
				kind: "hobo-box-worker",
				connectionRef: "oracle-free-vm",
				runsOn: "hobo-isolated-worker",
				enabled: true,
				environment: "ci",
			},
		]);
		expect(readCommittedBoxProviders(repoRoot, "another-box")).toEqual([]);
		expect(
			readCommittedBoxProviders(mkdtempSync(join(tmpdir(), "none-")), "x"),
		).toEqual([]);
	});

	it("refuses a provider that is not one", () => {
		const root = checkout({
			environments: {
				ci: { policy: { providers: [{ id: "x", kind: "nope" }] } },
			},
		});
		expect(() => readCommittedBoxProviders(root, "oracle-free-vm")).toThrow(
			/invalid provider/u,
		);
	});

	it("replaces the label, kind and enabled state the configuration carried", () => {
		const config = configuration([
			{
				id: "oracle-free-isolated",
				runsOn: "some-other-label",
				enabled: false,
				provider: "kubernetes",
			},
			// Another box's offer is not this one's business.
			{
				id: "elsewhere",
				providerAccountId: "other-box",
				runsOn: "other",
			},
		]);
		const report = applyCommittedBoxProviders(
			config,
			"oracle-free-vm",
			readCommittedBoxProviders(repoRoot, "oracle-free-vm"),
		);
		const [mine, theirs] = config.accounts[0]?.offers ?? [];
		expect(mine).toMatchObject({
			runsOn: "hobo-isolated-worker",
			provider: "hobo-box-worker",
			enabled: true,
		});
		expect(theirs?.runsOn).toBe("other");
		expect(report.changed.map((change) => change.field)).toEqual([
			"runsOn",
			"provider",
			"enabled",
		]);
		expect(report.uncommitted).toEqual([]);
	});

	it("leaves an offer no committed provider names as configured, and says so (R3)", () => {
		const config = configuration([{ id: "unnamed", runsOn: "custom" }]);
		const report = applyCommittedBoxProviders(config, "oracle-free-vm", []);
		expect(config.accounts[0]?.offers[0]?.runsOn).toBe("custom");
		expect(report).toEqual({
			changed: [],
			uncommitted: [{ accountId: "hobo-labs", offerId: "unnamed" }],
			conflicting: [],
		});
	});

	it("does not choose between committed providers that disagree", () => {
		const provider = {
			id: "box",
			kind: "hobo-box-worker",
			connectionRef: "oracle-free-vm",
			enabled: true,
		};
		const config = configuration([{ id: "box", runsOn: "custom" }]);
		const report = applyCommittedBoxProviders(config, "oracle-free-vm", [
			{ ...provider, runsOn: "a", environment: "ci" },
			{ ...provider, runsOn: "b", environment: "local" },
		]);
		expect(config.accounts[0]?.offers[0]?.runsOn).toBe("custom");
		expect(report.conflicting).toEqual(["box"]);
	});

	it("serves the committed fleet labels, never a constant", () => {
		const policy = {
			...DEFAULT_RUNNER_ROUTING,
			labels: { ...DEFAULT_RUNNER_ROUTING.labels, fleet: "f", trunk: "t" },
		};
		expect(boxFleetLabels(policy, 1)).toEqual(["f", "t"]);
		expect(boxFleetLabels(policy, 0)).toEqual(["f"]);
		// The daemon advertises, decides and watches with these.
		expect(daemon).toMatch(
			/const fleetLabels = boxFleetLabels\(routing, trunkSlots\);/u,
		);
		expect(daemon).toMatch(/labels: fleetLabels,\n/u);
		expect(daemon).not.toMatch(
			/\[routing\.labels\.fleet, routing\.labels\.trunk\]/u,
		);
		// The configuration's offers are overwritten from committed providers.
		expect(daemon).toMatch(
			/applyCommittedBoxProviders\(\s*configuration,\s*workerAccountId,\s*readCommittedBoxProviders\(checkoutRoot, workerAccountId\),/u,
		);
	});
});
