import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inMemoryState } from "alchemy";

export const BETTER_AUTH_HOST_DOTENV_FIXTURE = Object.freeze({
	HOBO_AUTH_BASE_PATH: "/api/auth",
	HOBO_AUTH_DATABASE_PROFILE: "data.relational/v1",
	HOBO_AUTH_SECRET_REF: "hobo-secret://camp-test/auth/better-auth-signing-key",
	HOBO_AUTH_CAMP_AUTHORITY: "camp-test",
	HOBO_AUTH_RELATIONAL_BINDLE: "auth_db",
	HOBO_AUTH_HTTP_BINDLE: "auth_http",
} as const);

export type BetterAuthHostDotEnv = typeof BETTER_AUTH_HOST_DOTENV_FIXTURE;

export interface BetterAuthHostStackInputs {
	readonly configInput: {
		readonly basePath: string;
		readonly secretRef: string;
		readonly database: { readonly profile: string };
		readonly emailAndPassword: { readonly enabled: boolean };
		readonly socialProviders: string[];
		readonly organizations: { readonly enabled: boolean };
	};
	readonly portsInput: {
		readonly relationalBindle: string;
		readonly httpBindle: string;
		readonly signingSecretRef: string;
	};
	readonly campAuthority: string;
}

export function parseBetterAuthHostDotEnv(
	env: Record<string, string | undefined> = BETTER_AUTH_HOST_DOTENV_FIXTURE,
): BetterAuthHostStackInputs {
	const basePath = env.HOBO_AUTH_BASE_PATH;
	const secretRef = env.HOBO_AUTH_SECRET_REF;
	const campAuthority = env.HOBO_AUTH_CAMP_AUTHORITY;
	const profile = env.HOBO_AUTH_DATABASE_PROFILE;
	const relationalBindle = env.HOBO_AUTH_RELATIONAL_BINDLE;
	const httpBindle = env.HOBO_AUTH_HTTP_BINDLE;
	if (
		!basePath ||
		!secretRef ||
		!campAuthority ||
		!profile ||
		!relationalBindle ||
		!httpBindle
	) {
		throw new Error(
			"better-auth host dotenv is missing a required HOBO_AUTH_* construction key",
		);
	}
	return Object.freeze({
		campAuthority,
		configInput: Object.freeze({
			basePath,
			secretRef,
			database: { profile },
			emailAndPassword: { enabled: true },
			socialProviders: ["github"],
			organizations: { enabled: false },
		}),
		portsInput: Object.freeze({
			relationalBindle,
			httpBindle,
			signingSecretRef: secretRef,
		}),
	});
}

export interface BetterAuthHostHarness {
	readonly stackName: string;
	readonly stage: string;
	readonly dotEnv: BetterAuthHostDotEnv;
	readonly sqlite: string;
	readonly sessionStorePath: string;
	createInMemoryAlchemyState(): ReturnType<typeof inMemoryState>;
	dispose(): void;
}

export function createBetterAuthHostHarness(): BetterAuthHostHarness {
	const directory = mkdtempSync(join(tmpdir(), "hobo-better-auth-host-"));
	const alchemyHome = join(directory, "alchemy");
	mkdirSync(alchemyHome, { recursive: true });
	const relationalDir = join(alchemyHome, "relational");
	mkdirSync(relationalDir, { recursive: true });
	const sessionStorePath = join(relationalDir, "session.db");
	const previousHome = process.env.ALCHEMY_HOME;
	const previousTelemetry = process.env.ALCHEMY_TELEMETRY_DISABLED;
	process.env.ALCHEMY_HOME = alchemyHome;
	process.env.ALCHEMY_TELEMETRY_DISABLED = "1";
	return {
		stackName: "better-auth-host",
		stage: "test",
		dotEnv: BETTER_AUTH_HOST_DOTENV_FIXTURE,
		sqlite: sessionStorePath,
		sessionStorePath,
		createInMemoryAlchemyState: () => inMemoryState(),
		dispose() {
			if (previousHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previousHome;
			if (previousTelemetry === undefined)
				delete process.env.ALCHEMY_TELEMETRY_DISABLED;
			else process.env.ALCHEMY_TELEMETRY_DISABLED = previousTelemetry;
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
