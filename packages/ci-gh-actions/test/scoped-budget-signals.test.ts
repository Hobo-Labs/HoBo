import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ciBudgetPolicyJson,
	effectiveCiAccount,
	parseCiPolicy,
} from "@hobo/ci";
import { LeaseStore } from "@hobo/ci/store";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { foldBudgetSignals } from "../../broker/src/budget-signals.js";
import { createCiBudgetRoutingBridge } from "../../stations/src/ci-routing.js";
import { createCiRelayClient } from "../src/client.js";
import {
	applyCiEnvironmentPolicy,
	ciEnvironmentPolicySha256,
	defineCiProjectConfig,
	parseCiProjectConfig,
	selectCiEnvironment,
} from "../src/project-config.js";
import { commonBudget, commonCiIntent } from "./fixtures/common-budget.js";
import { controlHttp, strictGithub } from "./fixtures/control-api-github.js";
import { harness } from "./fixtures.js";

const running: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const stop of running.splice(0)) await stop();
});

async function setup(budget = commonBudget()) {
	const directory = await mkdtemp(join(tmpdir(), "hobo-scoped-ci-budget-"));
	const databasePath = join(directory, "leases.sqlite");
	const h = harness(databasePath);
	const token = "scoped-budget-observer-token-at-least-32-characters";
	const credentials = JSON.stringify({
		tokens: [
			{
				accountId: "account-a",
				installationIds: [10],
				tokenSha256: createHash("sha256").update(token).digest("hex"),
				scopes: ["policy:read", "policy:write", "observations:write"],
			},
		],
	});
	const http = await controlHttp({
		relay: h.relay,
		configuration: h.configuration,
		credentialJson: credentials,
		github: strictGithub([]).github,
	});
	running.push(async () => {
		await http.stop();
		await rm(directory, { recursive: true, force: true });
	});
	const client = createCiRelayClient({
		origin: http.base,
		allowInsecureLoopback: true,
		accountToken: () => token,
	});
	const account = h.configuration.accounts[0];
	if (!account) throw new Error("fixture account absent");
	const intent = commonCiIntent(account, budget);
	await mkdir(join(directory, ".hobo"));
	const projectPath = join(directory, ".hobo", "ci.json");
	await writeFile(
		projectPath,
		JSON.stringify({
			defaultEnvironment: "local",
			environments: {
				local: {
					relayOrigin: http.base,
					allowInsecureLoopback: true,
					policy: intent,
				},
			},
		}),
	);
	const project = parseCiProjectConfig(await readFile(projectPath, "utf8"));
	const selected = selectCiEnvironment(project);
	const sdk = defineCiProjectConfig({
		defaultEnvironment: "local",
		environments: {
			local: {
				relayOrigin: selected.relayOrigin,
				allowInsecureLoopback: true,
				policy: selected.policy,
			},
		},
	});
	await applyCiEnvironmentPolicy(sdk, "local", {
		trustedTargets: [
			{ environment: "local", origin: http.base, accountId: account.id },
		],
		accountToken: () => token,
		expectedPolicySha256: await ciEnvironmentPolicySha256(sdk, "local"),
	});
	const bridge = createCiBudgetRoutingBridge({
		policy: {
			accountId: account.id,
			tenantId: budget.tenantId,
			budgetPolicy: budget,
			normalOfferIds: [account.offers[0]?.id ?? ""],
			thresholds: [{ thresholdFraction: 1, offerIds: [] }],
		},
		client,
	});
	const signals = (periodId = budget.periodId) =>
		foldBudgetSignals(
			[
				{
					type: "meter.UsageRecorded",
					data: {
						tenantId: budget.tenantId,
						budgetId: budget.budgetId,
						periodId,
						costUsd: 1.2,
					},
				},
				{
					type: "budget.CreditApplied",
					data: {
						tenantId: budget.tenantId,
						budgetId: budget.budgetId,
						periodId,
						amountUsd: 1,
					},
				},
			],
			{
				budgetUsd: budget.limitMicros / 1_000_000,
				thresholds: [1],
				identity: {
					tenantId: budget.tenantId,
					budgetId: budget.budgetId,
					periodId,
					policyRevision: budget.revision,
				},
			},
		).signals;
	return {
		h,
		client,
		bridge,
		intent,
		budget,
		signals,
		base: http.base,
		databasePath,
		stop: http.stop,
	};
}

it("publishes real scoped Broker reset, crossing and recovery through local HTTP without rewriting provider authority", async () => {
	const t = await setup();
	const [reset, crossing, recovery] = t.signals();
	if (!reset || !crossing || !recovery)
		throw new Error("missing scoped signals");
	await t.bridge.accept(JSON.stringify(reset));
	await t.bridge.accept(JSON.stringify(crossing));
	let current = await t.client.getSignalState();
	if (!current.account) throw new Error("account missing");
	expect(current.account.offers[0]?.enabled).toBe(true);
	expect(
		effectiveCiAccount(current.account, parseCiPolicy(JSON.stringify(t.intent)))
			.offers[0]?.enabled,
	).toBe(false);
	expect(await t.bridge.accept(JSON.stringify(reset))).toMatchObject({
		changed: false,
	});
	await t.bridge.accept(JSON.stringify(recovery));
	current = await t.client.getSignalState();
	if (!current.account) throw new Error("account missing");
	expect(
		effectiveCiAccount(current.account, parseCiPolicy(JSON.stringify(t.intent)))
			.offers[0]?.enabled,
	).toBe(true);
	expect(Object.values(current.account.routingSignalCycles)).toEqual([3]);
});

it("refuses legacy recovery and foreign period signals while preserving scoped pause and watermarks", async () => {
	const t = await setup();
	const crossing = t.signals()[1];
	if (!crossing) throw new Error("missing crossing");
	await t.bridge.accept(JSON.stringify(crossing));
	const before = await t.client.getSignalState();
	const legacy = foldBudgetSignals(
		[
			{
				type: "meter.UsageRecorded",
				data: { tenantId: "tenant-a", costUsd: 2 },
			},
			{
				type: "budget.CreditApplied",
				data: { tenantId: "tenant-a", amountUsd: 2 },
			},
		],
		{ tenantId: "tenant-a", budgetUsd: 1 },
	).signals[1];
	await expect(t.bridge.accept(JSON.stringify(legacy))).rejects.toThrow();
	await expect(
		t.bridge.accept(JSON.stringify(t.signals("foreign-period")[0])),
	).rejects.toThrow();
	expect(await t.client.getSignalState()).toEqual(before);
});

it("initializes a zero budget as crossed through an explicit reset", async () => {
	const t = await setup(commonBudget("zero-period", 0));
	const reset = t.signals()[0];
	if (!reset) throw new Error("missing zero reset");
	await t.bridge.accept(JSON.stringify(reset));
	const current = await t.client.getSignalState();
	if (!current.account) throw new Error("account missing");
	expect(Object.values(current.account.routingSignalCycles)).toEqual([1]);
	expect(Object.values(current.account.routingSignalCrossed)).toEqual([true]);
	expect(
		effectiveCiAccount(current.account, parseCiPolicy(JSON.stringify(t.intent)))
			.offers[0]?.enabled,
	).toBe(false);
});

it("preserves common policy in local PUT and refuses removal or legacy replacement", async () => {
	const t = await setup();
	const current = await t.client.getPolicy();
	expect(current.account?.budgetPolicy).toEqual(t.budget);
	const { budgetPolicy: _policy, ...legacy } = t.intent;
	await expect(
		t.client.putDesiredPolicy(legacy, { revision: current.revision }),
	).rejects.toThrow();
	if (!current.account) throw new Error("account missing");
	await expect(
		t.client.putPolicy(current.account, { revision: current.revision }),
	).rejects.toThrow();
	expect((await t.client.getPolicy()).account?.budgetPolicy).toEqual(t.budget);
	t.h.store.rebuild();
	const replayed = await t.client.getPolicy();
	const record = t.h.store.controlRecord("ci-policy:account-a");
	if (!record) throw new Error("replayed desired policy missing");
	expect(ciBudgetPolicyJson(replayed.account?.budgetPolicy)).toBe(
		ciBudgetPolicyJson(t.budget),
	);
	expect(ciBudgetPolicyJson(parseCiPolicy(record.bodyJson).budgetPolicy)).toBe(
		ciBudgetPolicyJson(t.budget),
	);
});

it("keeps prior-period watermarks when an explicitly new period is configured", async () => {
	const t = await setup();
	const crossing = t.signals()[1];
	if (!crossing) throw new Error("missing crossing");
	await t.bridge.accept(JSON.stringify(crossing));
	const before = await t.client.getPolicy();
	if (!before.account) throw new Error("account missing");
	const next = commonCiIntent(before.account, {
		...commonBudget("period-b"),
		revision: "revision-b",
	});
	await t.client.putDesiredPolicy(next, { revision: before.revision });
	await expect(
		t.bridge.accept(JSON.stringify(t.signals()[2])),
	).rejects.toThrow();
	const after = await t.client.getPolicy();
	expect(after.account?.routingSignalCycles).toEqual(
		before.account.routingSignalCycles,
	);
	expect(after.account?.budgetPolicy?.periodId).toBe("period-b");
});

it("reopens committed project and SDK policy from SQLite and rebuilds the same canonical controls", async () => {
	const t = await setup();
	await t.stop();
	const reopened = new LeaseStore(t.databasePath);
	try {
		reopened.rebuild();
		const account = reopened.configuration()?.configuration?.accounts[0];
		const record = reopened.controlRecord("ci-policy:account-a");
		if (!record) throw new Error("replayed desired policy missing");
		expect(ciBudgetPolicyJson(account?.budgetPolicy)).toBe(
			ciBudgetPolicyJson(t.budget),
		);
		expect(
			ciBudgetPolicyJson(parseCiPolicy(record.bodyJson).budgetPolicy),
		).toBe(ciBudgetPolicyJson(t.budget));
		expect(reopened.all()).toEqual([]);
	} finally {
		reopened.close();
	}
});

it("executes every scoped signal Pact interaction against the local HTTP provider", async () => {
	const t = await setup();
	const pact = z
		.object({
			interactions: z.array(
				z.object({
					description: z.string(),
					request: z.object({
						method: z.literal("POST"),
						path: z.string(),
						headers: z.record(z.string(), z.string()),
						body: z.json(),
					}),
					response: z.object({ status: z.number(), body: z.json().optional() }),
				}),
			),
		})
		.parse(
			JSON.parse(
				readFileSync(
					new URL(
						"../contracts/scoped-budget-signals.pact.json",
						import.meta.url,
					),
					"utf8",
				),
			),
		);
	for (const interaction of pact.interactions) {
		const response = await fetch(`${t.base}${interaction.request.path}`, {
			method: interaction.request.method,
			headers: interaction.request.headers,
			body: JSON.stringify(interaction.request.body),
		});
		expect(response.status, interaction.description).toBe(
			interaction.response.status,
		);
		if (interaction.response.body !== undefined)
			expect(await response.json(), interaction.description).toMatchObject(
				interaction.response.body,
			);
	}
});
