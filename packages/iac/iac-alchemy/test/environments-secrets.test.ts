import { inMemoryState, Resource, Stack } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createHoboInfisicalSecrets,
	createOwnerStoreSecretProvider,
	createSecretlessStackSecrets,
	describeHoboAuthProfile,
	mapStageToInfisicalEnvironment,
	readRedactedConfigSecret,
	redactForProfileDetails,
	validateAlchemyProfile,
	validateAlchemyStage,
} from "../src/environments/index.js";
import { createAlchemyTestHarness } from "../src/test-harness/index.js";

type SecretConsumer = Resource<
	"Hobo.SecretConsumer",
	{ readonly stageTag: string },
	{ readonly observedStage: string; readonly redactedDisplay: string }
>;
const SecretConsumer = Resource<SecretConsumer>("Hobo.SecretConsumer");

describe("Alchemy Environments secret providers, stages, and profiles", () => {
	const observedAuthHeaders: string[] = [];
	const secretMaterialProd = "prod-owner-secret-value-9911";
	const secretMaterialDev = "dev-owner-secret-value-2244";
	const stateRecords: NonNullable<Parameters<typeof inMemoryState>[0]> = {};

	const providers = Provider.succeed(SecretConsumer, {
		reconcile: ({ news }) =>
			Effect.gen(function* () {
				const token = yield* readRedactedConfigSecret("SERVICE_CREDENTIAL");
				observedAuthHeaders.push(Redacted.value(token));
				return {
					observedStage: news.stageTag,
					redactedDisplay: String(token),
				};
			}),
		delete: () => Effect.void,
	});

	const ownerSecrets = createSecretlessStackSecrets([
		createOwnerStoreSecretProvider({
			keys: {},
			perStageKeys: (stage) => ({
				SERVICE_CREDENTIAL:
					stage === "prod"
						? "owner://PROD_CREDENTIAL"
						: "owner://DEV_CREDENTIAL",
			}),
			resolveCredential: async (locator) =>
				locator === "owner://PROD_CREDENTIAL"
					? secretMaterialProd
					: secretMaterialDev,
		}),
	]);

	const harness = createAlchemyTestHarness({
		providers,
		state: inMemoryState(stateRecords),
		stage: "test-secrets",
		secrets: ownerSecrets,
	});

	const stack = Stack(
		"secretless-env-stack",
		{
			providers,
			state: harness.state,
			secrets: [...ownerSecrets],
		},
		Effect.gen(function* () {
			const consumer = yield* SecretConsumer("consumer", {
				stageTag: "verified",
			});
			return {
				observedStage: consumer.observedStage,
				redactedDisplay: consumer.redactedDisplay,
			};
		}),
	);

	let deployedOutputs: {
		readonly observedStage: string;
		readonly redactedDisplay: string;
	};

	beforeAll(async () => {
		deployedOutputs = await harness.deploy(stack, { stage: "prod" });
	});

	afterAll(async () => {
		await harness.destroy(stack, { stage: "prod" });
	});

	it("maps stages to Infisical environments and validates Alchemy stage/profile names", () => {
		expect(mapStageToInfisicalEnvironment("prod")).toBe("prod");
		expect(mapStageToInfisicalEnvironment("staging")).toBe("staging");
		expect(mapStageToInfisicalEnvironment("pr-42")).toBe("dev");
		expect(mapStageToInfisicalEnvironment("dev_alice")).toBe("dev");
		expect(
			mapStageToInfisicalEnvironment("pr-42", { "pr-42": "preview" }),
		).toBe("preview");

		expect(validateAlchemyStage("test_runner-1")).toBe("test_runner-1");
		expect(() => validateAlchemyStage("INVALID_STAGE")).toThrow(
			"invalid Alchemy stage name",
		);
		expect(validateAlchemyProfile("work.prod-1")).toBe("work.prod-1");
		expect(() => validateAlchemyProfile("../escape")).toThrow(
			"invalid Alchemy profile name",
		);
	});

	it("constructs stage-aware Infisical secrets with ProcessEnv disabled by default", () => {
		const entries = createHoboInfisicalSecrets({
			project: "hobo-ci",
			path: "/runners",
		});
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			_tag: "alchemy/SecretProvider::ProcessEnv",
		});
		expect(entries[1]).toMatchObject({
			_tag: "alchemy/SecretProvider::Infisical",
		});

		const details = describeHoboAuthProfile({
			profile: "prod",
			stage: "prod",
			store: "Infisical",
			project: "hobo-ci",
			path: "/runners",
			credentialKeys: ["HOSTINGER_API_KEY", "AGENT37_API_KEY"],
		});
		expect(details.lines).toEqual([
			{ key: "profile", value: "prod" },
			{ key: "stage", value: "prod" },
			{ key: "store", value: "Infisical" },
			{ key: "project", value: "hobo-ci" },
			{ key: "environment", value: "prod" },
			{ key: "path", value: "/runners" },
			{ key: "keys", value: "HOSTINGER_API_KEY, AGENT37_API_KEY" },
		]);
		expect(redactForProfileDetails("abcd123456")).toBe("abcd****");
		expect(redactForProfileDetails("abc")).toBe("****");
	});

	it("resolves Config.Redacted per stage from OwnerStoreSecretProvider with zero secret persistence in state", () => {
		expect(deployedOutputs.observedStage).toBe("verified");
		expect(deployedOutputs.redactedDisplay).toBe("<redacted>");
		expect(observedAuthHeaders).toContain(secretMaterialProd);
		expect(JSON.stringify(stateRecords)).not.toContain(secretMaterialProd);
	});

	it("isolates stages and blocks ambient process env leaks when Secrets.ProcessEnv is disabled", async () => {
		await harness.withProviderSession(async (session) => {
			const devDeployment = await session.deploy(
				"dev-stage-stack",
				Effect.gen(function* () {
					const consumer = yield* SecretConsumer("dev-consumer", {
						stageTag: "dev-stage",
					});
					return {
						observedStage: consumer.observedStage,
						redactedDisplay: consumer.redactedDisplay,
					};
				}),
				{ stage: "pr-99" },
			);
			expect(devDeployment.outputs.redactedDisplay).toBe("<redacted>");
			expect(observedAuthHeaders).toContain(secretMaterialDev);
			await devDeployment.destroy();
		});

		const isolatedConfig = Provider.succeed(SecretConsumer, {
			reconcile: () =>
				Effect.gen(function* () {
					const missing = yield* Config.String("PATH");
					return {
						observedStage: missing,
						redactedDisplay: "<unexpected>",
					};
				}),
			delete: () => Effect.void,
		});
		const noEnvHarness = createAlchemyTestHarness({
			providers: isolatedConfig,
			stage: "test-no-env",
			secrets: createSecretlessStackSecrets([]),
		});
		await expect(
			noEnvHarness.withProviderSession(async (session) => {
				await session.deploy(
					"no-env-stack",
					Effect.gen(function* () {
						yield* SecretConsumer("blocked", { stageTag: "blocked" });
						return {};
					}),
				);
			}),
		).rejects.toThrow();
	});
});
