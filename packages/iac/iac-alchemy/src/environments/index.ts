import * as Doppler from "@alchemy.run/doppler";
import * as Infisical from "@alchemy.run/infisical";
import type { ProviderDetails } from "alchemy/Auth";
import * as AlchemySecrets from "alchemy/Secrets";
import { Stage } from "alchemy/Stage";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import {
	type OwnerCredentialResolver,
	parseOwnerCredentialLocator,
} from "../runners/owner-credentials.js";

export {
	AuthError,
	BetterAuthSessionProfileConfig,
	DopplerProjectProfileConfig,
	HOBO_AUTH_CONFIGURE_METHODS,
	HOBO_AUTH_PROVIDER_NAME,
	HoboAuthCredentialBroker,
	type HoboAuthCredentialBrokerService,
	HoboAuthCredentials,
	HoboAuthCredentialsFromProviderLayer,
	type HoboAuthProfileConfig,
	HoboAuthProfileConfigSchema,
	HoboAuthProviderLayer,
	type HoboAuthResolvedCredentials,
	type HoboBetterAuthDatabaseTarget,
	type HoboSecretStoreKind,
	InfisicalUniversalAuthProfileConfig,
	NeedsReauth,
	OwnerStoreProfileConfig,
	renderHoboAuthProfileDetails,
} from "./auth-provider.js";
export { type OwnerCredentialResolver, Stage };

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

export interface HoboDopplerSecretsOptions {
	readonly project: string;
	readonly stageConfigMap?: Readonly<Record<string, string>>;
	readonly disableProcessEnv?: boolean;
}

export type HoboSecretProvidersSpec =
	| Readonly<{
			readonly kind: "infisical";
			readonly options: HoboInfisicalSecretsOptions;
	  }>
	| Readonly<{
			readonly kind: "doppler";
			readonly options: HoboDopplerSecretsOptions;
	  }>
	| Readonly<{
			readonly kind: "owner-store";
			readonly options: OwnerStoreSecretProviderOptions;
			readonly disableProcessEnv?: boolean;
	  }>;

export interface HoboBetterAuthResolvedConfig {
	readonly signingSecret: Redacted.Redacted<string>;
	readonly baseUrl: string;
	readonly basePath: string;
	readonly trustedOrigins: readonly string[];
	readonly githubAppOAuth: Option.Option<{
		readonly clientId: string;
		readonly clientSecret: Redacted.Redacted<string>;
	}>;
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

export function mapStageToDopplerConfig(
	stage: string,
	overrides?: Readonly<Record<string, string>>,
): string {
	const valid = validateAlchemyStage(stage);
	if (overrides !== undefined && Object.hasOwn(overrides, valid)) {
		const mapped = overrides[valid];
		if (mapped !== undefined && mapped.length > 0) return mapped;
	}
	if (valid === "prod" || valid === "production") return "prd";
	if (valid === "staging" || valid === "stage") return "stg";
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

export function createHoboDopplerSecrets(
	options: HoboDopplerSecretsOptions,
): readonly AlchemySecrets.SecretsEntry[] {
	const dopplerEntry = Doppler.Secrets(({ stage }) => ({
		project: options.project,
		config: mapStageToDopplerConfig(stage, options.stageConfigMap),
	}));
	if (options.disableProcessEnv === false) {
		return [dopplerEntry];
	}
	return [AlchemySecrets.ProcessEnv({ disabled: true }), dopplerEntry];
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
	readonly nonSecretValues?: Readonly<Record<string, string>>;
	readonly perStageNonSecretValues?: (
		stage: string,
	) => Readonly<Record<string, string>>;
}

export function createOwnerStoreConfigLayer(
	options: OwnerStoreSecretProviderOptions,
): Layer.Layer<never, AlchemyEnvironmentConfigError, Stage> {
	return Layer.unwrap(
		Effect.gen(function* () {
			const stage = yield* Stage;
			const mapping =
				options.perStageKeys !== undefined
					? { ...options.keys, ...options.perStageKeys(stage) }
					: options.keys;
			const resolvedEntries: Record<string, string> = {};
			if (options.nonSecretValues !== undefined) {
				Object.assign(resolvedEntries, options.nonSecretValues);
			}
			if (options.perStageNonSecretValues !== undefined) {
				Object.assign(resolvedEntries, options.perStageNonSecretValues(stage));
			}
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
}

export function createOwnerStoreSecretProvider(
	options: OwnerStoreSecretProviderOptions,
): OwnerStoreSecretProvider {
	return new OwnerStoreSecretProvider({
		layer: createOwnerStoreConfigLayer(options),
	});
}

export function createHoboSecretProviders(
	spec: HoboSecretProvidersSpec,
): readonly AlchemySecrets.SecretsEntry[] {
	switch (spec.kind) {
		case "infisical":
			return createHoboInfisicalSecrets(spec.options);
		case "doppler":
			return createHoboDopplerSecrets(spec.options);
		case "owner-store": {
			const ownerEntry = createOwnerStoreSecretProvider(spec.options);
			if (spec.disableProcessEnv === false) {
				return [ownerEntry];
			}
			return [AlchemySecrets.ProcessEnv({ disabled: true }), ownerEntry];
		}
	}
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

export const readHoboBetterAuthConfig: Effect.Effect<
	HoboBetterAuthResolvedConfig,
	Config.ConfigError
> = Effect.gen(function* () {
	const signingSecret = yield* Config.Redacted("HOBO_AUTH_SECRET");
	const baseUrl = yield* Config.String("HOBO_AUTH_BASE_URL");
	const basePath = yield* Config.String("HOBO_AUTH_BASE_PATH").pipe(
		Config.withDefault("/api/auth"),
	);
	const trustedRaw = yield* Config.option(
		Config.String("HOBO_AUTH_TRUSTED_ORIGINS"),
	);
	const trustedOrigins = Option.match(trustedRaw, {
		onNone: () => [baseUrl],
		onSome: (raw) => {
			const parsed = raw
				.split(",")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0);
			return parsed.length > 0 ? parsed : [baseUrl];
		},
	});
	const githubClientId = yield* Config.option(
		Config.String("HOBO_AUTH_GITHUB_APP_CLIENT_ID"),
	);
	const githubClientSecret = yield* Config.option(
		Config.Redacted("HOBO_AUTH_GITHUB_APP_CLIENT_SECRET"),
	);
	const githubAppOAuth =
		Option.isSome(githubClientId) && Option.isSome(githubClientSecret)
			? Option.some({
					clientId: githubClientId.value,
					clientSecret: githubClientSecret.value,
				})
			: Option.none();
	return {
		signingSecret,
		baseUrl,
		basePath,
		trustedOrigins,
		githubAppOAuth,
	};
});

export function redactForProfileDetails(value: string): string {
	if (value.length <= 4) return "****";
	return `${value.slice(0, 4)}****`;
}

export function describeHoboAuthProfile(input: {
	readonly profile: string;
	readonly stage: string;
	readonly store: "Infisical" | "Doppler" | "OwnerStore";
	readonly project: string;
	readonly path: string;
	readonly credentialKeys: readonly string[];
}): ProviderDetails {
	const profile = validateAlchemyProfile(input.profile);
	const stage = validateAlchemyStage(input.stage);
	const environment =
		input.store === "Doppler"
			? mapStageToDopplerConfig(stage)
			: mapStageToInfisicalEnvironment(stage);
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
