import { create, toJsonString } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ConfigurationSchema, LeaseSchema } from "../src/_generated/ci_pb.js";
import { DesiredCiPolicySchema } from "../src/_generated/policy_pb.js";
import { parseConfiguration } from "../src/config.js";
import { defineCiPolicy } from "../src/policy.js";
import { route } from "../src/routing.js";

const now = "2026-10-29T12:00:00Z";
function configuration() {
	return create(ConfigurationSchema, {
		accounts: [
			{
				id: "dev",
				budgetMicros: 0,
				maxRuntimeMinutes: 9,
				startupMinutes: 1,
				offers: [
					{
						id: "dev-machine",
						provider: "local",
						providerAccountId: "developer-workstation",
						enabled: true,
						runsOn: "hobo-local-host",
						backend: "gh-actions",
						concurrency: 1,
						observedAt: now,
						validUntil: "2026-10-29T13:00:00Z",
						sourceUrl:
							"https://github.com/example/private/settings/actions/runners",
						bridgeAcknowledged: true,
					},
				],
			},
		],
	});
}
function localAccount() {
	const parsed = parseConfiguration(
		toJsonString(ConfigurationSchema, configuration()),
	);
	const account = parsed.accounts[0];
	if (!account) throw new Error("missing local account");
	return account;
}

describe("local workstation offers", () => {
	it("admits an explicitly observed workstation without paid budget or invented credits", () => {
		const choice = route(localAccount(), [], now);
		expect(choice).toMatchObject({
			offer: { provider: "local", runsOn: "hobo-local-host" },
			minutes: 10,
			freeMinutes: 0,
			paidMicros: 0,
		});
	});
	it("holds one workstation slot until an ambiguous or running lease is settled", () => {
		const account = localAccount();
		const lease = create(LeaseSchema, {
			accountId: account.id,
			offerId: "dev-machine",
			state: "uncertain",
			reservedMinutes: 10,
		});
		expect(route(account, [lease], now)).toBeUndefined();
		lease.state = "completed";
		lease.settledAt = now;
		expect(route(account, [lease], now)?.paidMicros).toBe(0);
	});
	it.each([
		"disabled",
		"unacknowledged",
		"stale",
		"insufficient-window",
	])("leaves local demand queued when availability is %s", (condition) => {
		const account = localAccount();
		const offer = account.offers[0];
		if (!offer) throw new Error("missing offer");
		if (condition === "disabled") offer.enabled = false;
		if (condition === "unacknowledged") offer.bridgeAcknowledged = false;
		if (condition === "stale") offer.validUntil = now;
		if (condition === "insufficient-window")
			offer.validUntil = "2026-10-29T12:09:59Z";
		expect(route(account, [], now)).toBeUndefined();
	});
	it.each([
		{ backend: "dagger" },
		{ backend: "" },
		{ runsOn: "hobo" },
		{ runsOn: "ubuntu-24.04" },
		{ concurrency: 2 },
		{ freeMinutes: 1 },
		{ priceMicrosPerMinute: 1 },
	])("rejects a local offer outside the workstation contract: %j", (override) => {
		const input = configuration();
		const account = input.accounts[0];
		if (!account) throw new Error("missing account");
		const offer = account.offers[0];
		if (!offer) throw new Error("missing offer");
		Object.assign(offer, override);
		expect(() =>
			parseConfiguration(toJsonString(ConfigurationSchema, input)),
		).toThrow();
	});
	it("authors local policy for the existing Linux x64 bridge without balances", () => {
		const policy = defineCiPolicy({
			accountId: "dev",
			tenantId: "dev",
			pool: { label: "hobo", os: "linux", architecture: "x64" },
			providers: [
				{
					id: "dev-machine",
					kind: "local",
					connectionRef: "developer-workstation",
					runsOn: "hobo-local-host",
					enabled: true,
				},
			],
			budget: {
				scope: "ci-account",
				currency: "USD",
				limitMicros: 0,
				period: "manual",
				timeZone: "UTC",
			},
			routing: {
				strategy: "lowest-total-incremental-cost",
				noEligibleProvider: "queue",
				unknownAllocation: "zero",
			},
		});
		expect(policy.providers[0]?.kind).toBe("local");
		const authored = JSON.parse(toJsonString(DesiredCiPolicySchema, policy));
		expect(() =>
			defineCiPolicy({
				...authored,
				pool: { ...authored.pool, architecture: "arm64" },
			}),
		).toThrow("unsupported CI runner pool");
		authored.providers[0].runsOn = "ubuntu-24.04";
		expect(() => defineCiPolicy(authored)).toThrow(
			"invalid CI provider declaration",
		);
	});
});
