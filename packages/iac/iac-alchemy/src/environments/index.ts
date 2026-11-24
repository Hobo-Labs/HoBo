import * as Infisical from "@alchemy.run/infisical";
import type { ProviderDetails } from "alchemy/Auth";
import * as AlchemySecrets from "alchemy/Secrets";
import { Stage } from "alchemy/Stage";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import {
	type OwnerCredentialResolver,
	parseOwnerCredentialLocator,
} from "../runners/owner-credentials.js";

const ALCHEMY_STAGE_PATTERN = /^[a-z0-9][-_a-z0-9]*$/u;
const ALCHEMY_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export class AlchemyEnvironmentConfigError extends Data.TaggedError(
	"AlchemyEnvironmentConfigError",
)<{
	readonly code: "INVALID_STAGE" | "INVALID_PROFILE" | "OWNER_SECRET_MISSING";
	readonly message: string;
}> {}

export interface HoboInfisicalSecretsOptions {
	readonly project: string;
	readonly path?: string;
	readonly recursive?: boolean;
	readonly includeImports?: boolean;
	readonly stageEnvironmentMap?: Readonly<Record<string, string>>;
	readonly disableProcessEnv?: boolean;
}

export function validateAlchemyStage(stage: string): string {
	if (!ALCHEMY_STAGE_PATTERN.test(stage)) {
		throw new AlchemyEnvironmentConfigError({
			code: "INVALID_STAGE",
			message: `invalid Alchemy stage name: ${stage}`,
		});
	}
	return stage;
}

export function validateAlchemyProfile(profile: string): string {
	if (!ALCHEMY_PROFILE_PATTERN.test(profile)) {
		throw new AlchemyEnvironmentConfigError({
			code: "INVALID_PROFILE",
			message: `invalid Alchemy profile name: ${profile}`,
		});
	}
	return profile;
}

export function mapStageToInfisicalEnvironment(
	stage: string,
	overrides?: Readonly<Record<string, string>>,
): string {
	const valid = validateAlchemyStage(stage);
	if (overrides !== undefined && Object.hasOwn(overrides, valid)) {
		const mapped = overrides[valid];
		if (mapped !== undefined && mapped.length > 0) return mapped;
	}
	if (valid === "prod" || valid === "production") return "prod";
	if (valid === "staging" || valid === "stage") return "staging";
	return "dev";
}

export function createHoboInfisicalSecrets(
	options: HoboInfisicalSecretsOptions,
): readonly AlchemySecrets.SecretsEntry[] {
	const infisicalEntry = Infisical.Secrets(({ stage }) => ({
		project: options.project,
		environment: mapStageToInfisicalEnvironment(
			stage,
			options.stageEnvironmentMap,
		),
		path: options.path ?? "/",
		recursive: options.recursive ?? false,
		includeImports: options.includeImports ?? true,
	}));
	if (options.disableProcessEnv === false) {
		return [infisicalEntry];
	}
	return [AlchemySecrets.ProcessEnv({ disabled: true }), infisicalEntry];
}

export class OwnerStoreSecretProvider extends Data.TaggedClass(
	"hobo/SecretProvider::OwnerStore",
)<{
	readonly layer: AlchemySecrets.SecretsLayer;
}> {}

export interface OwnerStoreSecretProviderOptions {
	readonly keys: Readonly<Record<string, string>>;
	readonly resolveCredential: OwnerCredentialResolver;
	readonly perStageKeys?: (stage: string) => Readonly<Record<string, string>>;
}

export function createOwnerStoreSecretProvider(
	options: OwnerStoreSecretProviderOptions,
): OwnerStoreSecretProvider {
	const layer: AlchemySecrets.SecretsLayer = Layer.unwrap(
		Effect.gen(function* () {
			const stage = yield* Stage;
			const mapping =
				options.perStageKeys !== undefined
					? { ...options.keys, ...options.perStageKeys(stage) }
					: options.keys;
			const resolvedEntries: Record<string, string> = {};
			for (const [configKey, locator] of Object.entries(mapping)) {
				const validatedLocator = parseOwnerCredentialLocator(locator);
				const secretValue = yield* Effect.tryPromise({
					try: async () => await options.resolveCredential(validatedLocator),
					catch: (cause) =>
						new AlchemyEnvironmentConfigError({
							code: "OWNER_SECRET_MISSING",
							message:
								cause instanceof Error
									? cause.message
									: `failed to resolve ${validatedLocator}`,
						}),
				});
				if (secretValue.trim().length === 0) {
					return yield* new AlchemyEnvironmentConfigError({
						code: "OWNER_SECRET_MISSING",
						message: `owner credential ${validatedLocator} resolved empty`,
					});
				}
				resolvedEntries[configKey] = secretValue;
			}
			return ConfigProvider.layerAdd(
				ConfigProvider.fromUnknown(resolvedEntries),
				{ asPrimary: true },
			);
		}),
	);
	return new OwnerStoreSecretProvider({ layer });
}

export function createSecretlessStackSecrets(
	entries: readonly AlchemySecrets.SecretsEntry[],
): readonly AlchemySecrets.SecretsEntry[] {
	return [AlchemySecrets.ProcessEnv({ disabled: true }), ...entries];
}

export function readRedactedConfigSecret(
	key: string,
): Effect.Effect<Redacted.Redacted<string>, Config.ConfigError> {
	return Config.Redacted(key);
}

export function redactForProfileDetails(value: string): string {
	if (value.length <= 4) return "****";
	return `${value.slice(0, 4)}****`;
}

export function describeHoboAuthProfile(input: {
	readonly profile: string;
	readonly stage: string;
	readonly store: "Infisical" | "OwnerStore";
	readonly project: string;
	readonly path: string;
	readonly credentialKeys: readonly string[];
}): ProviderDetails {
	const profile = validateAlchemyProfile(input.profile);
	const stage = validateAlchemyStage(input.stage);
	const environment = mapStageToInfisicalEnvironment(stage);
	return {
		lines: [
			{ key: "profile", value: profile },
			{ key: "stage", value: stage },
			{ key: "store", value: input.store },
			{ key: "project", value: input.project },
			{ key: "environment", value: environment },
			{ key: "path", value: input.path },
			{ key: "keys", value: input.credentialKeys.join(", ") },
		],
	};
}
