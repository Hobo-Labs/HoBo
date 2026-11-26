import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEPLOYMENT_PLAN_SCHEMA,
	type DeploymentPlan,
	deploymentPlanned,
	hashDeploymentPlan,
	type IacProgram,
	type ResourcePlan,
} from "@hobo/cloud";
import type { TransportRequest, TransportResponse } from "@hobo/core";
import {
	AWS_SECRETS_MANAGER_PRODUCT_ID,
	awsResolverRegistry,
	guardedAwsTransport,
} from "@hobo/provider-aws";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";
import { createResolverBackedIacProvider } from "../src/resolver-iac-provider.js";

// A Secrets Manager secret scheduled for deletion, through the resolver-backed
// IacProvider: what preview, drift and apply say about it (ADR-0175).
//
// DeleteSecret only schedules a deletion, and through the recovery window the
// secret keeps its name; CreateSecret refuses it. So the resolver's read() reports it as
// being deleted (action `delete`) and preview must not say "apply would create
// it". Apply fails closed unless the plan declares `restoreScheduled: true`.
//
// NOT PROVEN: no AWS. The transport is a fake Secrets Manager holding one
// scheduled secret, behind the real AWS transport guard and SigV4 signing.

const DEPLOYMENT_ID = "dep-secret-1";
const CREDENTIAL_REF = "secret://camp/aws-deploy";
const NAME = "stripe-key";
const NOW_MS = Date.parse("2026-03-04T05:06:07.000Z");
const DELETED_DATE_SECONDS = NOW_MS / 1000 + 30 * 24 * 60 * 60;
const DELETED_DATE = new Date(DELETED_DATE_SECONDS * 1000).toISOString();

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

async function storeWith(
	resource: ResourcePlan,
): Promise<RuntimeLocalEventStore> {
	const store = createRuntimeLocalEventStore({
		dataDir: mkdtempSync(join(tmpdir(), "hobo-scheduled-secret-")),
		clock: createManualClock(),
	});
	openStores.push(store);
	const plan: DeploymentPlan = {
		schema: DEPLOYMENT_PLAN_SCHEMA,
		resources: [resource],
		dependencyOrder: [resource.name],
		objective: "min-cost",
	};
	await store.append(
		`deployment:${DEPLOYMENT_ID}`,
		[
			deploymentPlanned({
				deploymentId: DEPLOYMENT_ID,
				planHash: hashDeploymentPlan(plan),
				plan,
			}),
		],
		{
			expectedSeq: 0,
			actor: { kind: "system", id: "test" },
			tenant: "hobo-dev",
		},
	);
	return store;
}

function secretNode(realizationParameters: JsonObject): ResourcePlan {
	return {
		name: NAME,
		port: "secretRef",
		provider: "aws",
		deps: [],
		productId: AWS_SECRETS_MANAGER_PRODUCT_ID,
		realizationParameters,
	};
}

function program(action: IacProgram["action"]): IacProgram {
	return {
		programId: `prog-${NAME}`,
		deploymentId: DEPLOYMENT_ID,
		resourceId: NAME,
		provider: "aws",
		driver: "resolver",
		action,
		stackName: `${DEPLOYMENT_ID}/${NAME}`,
	};
}

/** The account's one secret: its DeletedDate in epoch seconds, unset once restored. */
interface SecretState {
	deletedDate: number | undefined;
}

/** One scheduled secret; RestoreSecret clears its DeletedDate. */
function scheduledAccount() {
	return accountWith(DELETED_DATE_SECONDS);
}

/** One live secret: nothing scheduled. */
function liveAccount() {
	return accountWith(undefined);
}

function accountWith(deletedDate: number | undefined) {
	const state: SecretState = { deletedDate };
	const targets: string[] = [];
	const answer = (status: number, body: JsonObject): TransportResponse => ({
		status,
		headers: {},
		body: JSON.stringify(body),
	});
	async function transport(
		request: TransportRequest,
	): Promise<TransportResponse> {
		const target = (request.headers["x-amz-target"] ?? "").split(".")[1] ?? "";
		targets.push(target);
		const record = {
			ARN: `arn:aws:secretsmanager:us-east-1:123456789012:secret:${NAME}-AbCdEf`,
			Name: NAME,
			Description: "payment provider key",
			...(state.deletedDate === undefined
				? undefined
				: { DeletedDate: state.deletedDate }),
		};
		if (target === "DescribeSecret") return answer(200, record);
		if (target === "RestoreSecret") {
			state.deletedDate = undefined;
			return answer(200, { ARN: record.ARN, Name: NAME });
		}
		return answer(400, {
			__type: "com.amazonaws.secretsmanager#InvalidRequestException",
			message: "The secret is scheduled for deletion.",
		});
	}
	return { transport, targets, state };
}

function driverFor(
	store: RuntimeLocalEventStore,
	account: ReturnType<typeof accountWith>,
) {
	return createResolverBackedIacProvider({
		store,
		registry: awsResolverRegistry({
			region: "us-east-1",
			nowMs: NOW_MS,
			resolveCredential: async () => ({
				accessKeyId: "AKIAHOBOFAKEKEYID001",
				secretAccessKey: "n0tARealSecretAccessKey0000000000000000x",
			}),
		}),
		transport: guardedAwsTransport(account.transport, "us-east-1"),
		credentialRef: CREDENTIAL_REF,
	});
}

describe("a secret scheduled for deletion, through the resolver-backed IacProvider", () => {
	it("preview says it is being deleted, with its DeletedDate, not that apply would create it", async () => {
		const account = scheduledAccount();
		const store = await storeWith(
			secretNode({ description: "payment provider key" }),
		);

		const diff = await driverFor(store, account).preview(program("preview"));

		expect(diff.summary).toContain("the provider is deleting it");
		expect(diff.summary).toContain(
			`scheduled for deletion (DeletedDate ${DELETED_DATE})`,
		);
		expect(diff.summary).toContain("apply refuses it");
		expect(diff.summary).not.toContain("apply would create it");
		expect(diff.changes).toBe(1);
		expect(account.targets).toEqual(["DescribeSecret"]);
	});

	it("drift reports it, determined, rather than certifying it clean", async () => {
		const account = scheduledAccount();
		const store = await storeWith(
			secretNode({ description: "payment provider key" }),
		);

		const report = await driverFor(store, account).refresh(program("preview"));

		expect(report.drift).toBe(true);
		expect(report.observed["hobo.resolver.drift.determined"]).toBe("true");
		expect(report.observed["hobo.resolver.drift.reason"]).toContain(
			`scheduled for deletion (DeletedDate ${DELETED_DATE})`,
		);
		expect(report.observed.deletedDate).toBe(DELETED_DATE);
	});

	it("apply refuses it by default and changes nothing", async () => {
		const account = scheduledAccount();
		const store = await storeWith(
			secretNode({ description: "payment provider key" }),
		);

		await expect(
			driverFor(store, account).apply(program("apply")),
		).rejects.toThrow(
			/scheduled for deletion \(DeletedDate .*restoreScheduled: true/u,
		);
		expect(account.targets).toEqual(["DescribeSecret"]);
		expect(account.state.deletedDate).toBe(DELETED_DATE_SECONDS);
	});

	it("with restoreScheduled, preview says restore and apply restores it with its previous versions", async () => {
		const account = scheduledAccount();
		const store = await storeWith(
			secretNode({
				description: "payment provider key",
				restoreScheduled: true,
			}),
		);
		const driver = driverFor(store, account);

		const diff = await driver.preview(program("preview"));
		expect(diff.summary).toContain(
			"apply will restore it, with its previous versions",
		);

		const outputs = await driver.apply(program("apply"));
		expect(outputs["hobo.resolver.action"]).toBe("update");
		expect(outputs["hobo.resolver.diagnostics"]).toContain(
			"with its previous versions",
		);
		expect(account.state.deletedDate).toBeUndefined();
		expect(account.targets).toEqual([
			"DescribeSecret",
			"DescribeSecret",
			"RestoreSecret",
			"DescribeSecret",
		]);
	});
});

// restoreScheduled and forceDelete say how apply and delete act; they are not
// facts about the secret, and no read reports them. A plan that keeps one must
// still preview and refresh clean once the secret is live (ADR-0175).
describe("a plan that keeps its directives, against a live secret", () => {
	it("previews no change and refreshes clean, naming the directives it did not compare", async () => {
		const account = liveAccount();
		const store = await storeWith(
			secretNode({
				description: "payment provider key",
				forceDelete: true,
				restoreScheduled: true,
			}),
		);
		const driver = driverFor(store, account);

		const diff = await driver.preview(program("preview"));
		expect(diff.changes).toBe(0);
		expect(diff.summary).toContain(
			"every compared declared parameter matches what the provider reports. Not compared: forceDelete, restoreScheduled",
		);
		expect(diff.summary).not.toContain("UNDETERMINED");

		const report = await driver.refresh(program("preview"));
		expect(report.drift).toBe(false);
		expect(report.observed["hobo.resolver.drift.determined"]).toBe("true");
		expect(report.observed["hobo.resolver.drift.notCompared"]).toBe(
			'["forceDelete","restoreScheduled"]',
		);
		expect(report.observed["hobo.resolver.drift.reason"]).toContain(
			"Not compared: forceDelete, restoreScheduled",
		);
	});

	it("still counts a real difference beside a directive", async () => {
		const account = liveAccount();
		const store = await storeWith(
			secretNode({ description: "another key", restoreScheduled: true }),
		);
		const driver = driverFor(store, account);

		const diff = await driver.preview(program("preview"));
		expect(diff.changes).toBe(1);
		expect(diff.summary).toContain(
			"declared parameter(s) differ (description)",
		);

		const report = await driver.refresh(program("preview"));
		expect(report.drift).toBe(true);
		expect(report.observed["hobo.resolver.drift.determined"]).toBe("true");
	});

	it("is clean on the next preview after apply restored the secret", async () => {
		const account = scheduledAccount();
		const store = await storeWith(
			secretNode({
				description: "payment provider key",
				restoreScheduled: true,
			}),
		);
		const driver = driverFor(store, account);

		await driver.apply(program("apply"));
		const diff = await driver.preview(program("preview"));
		const report = await driver.refresh(program("preview"));

		expect(account.state.deletedDate).toBeUndefined();
		expect(diff.changes).toBe(0);
		expect(report.drift).toBe(false);
	});
});

describe("a directive that is not a boolean, through the resolver-backed IacProvider", () => {
	it.each([
		[{ forceDelete: "true" }, "forceDelete"],
		[{ restoreScheduled: "true" }, "restoreScheduled"],
	] as const)("%o is refused by preview, apply and destroy, before any call", async (parameters, name) => {
		const account = scheduledAccount();
		const store = await storeWith(
			secretNode({ description: "payment provider key", ...parameters }),
		);
		const driver = driverFor(store, account);

		for (const call of [
			driver.preview(program("preview")),
			driver.apply(program("apply")),
			driver.destroy(program("destroy")),
		]) {
			await expect(call).rejects.toThrow(
				`${AWS_SECRETS_MANAGER_PRODUCT_ID}: desired.${name} must be a boolean (true or false)`,
			);
		}
		expect(account.targets).toEqual([]);
		expect(account.state.deletedDate).toBe(DELETED_DATE_SECONDS);
	});
});
