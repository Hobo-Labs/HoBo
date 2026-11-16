import { existsSync } from "node:fs";

import { z } from "zod";

import {
	ensureStoreCli,
	INFISICAL_CLI,
	type RunCommand,
	StoreCliInstallError,
} from "./store-cli.js";

/**
 * Connect Infisical with as little manual provisioning as Infisical allows.
 *
 * 1. Its CLI: found on the machine, else installed into HoBo's tools
 *    directory (`ensureStoreCli`).
 * 2. A user session: an existing CLI login is used as it is; otherwise the
 *    owner signs in once, with `infisical login` (their browser hands the
 *    session back to the CLI).
 * 3. Everything else through Infisical's API with that session: a machine
 *    identity (`hobo-<family>`, no organization role), its auth method (OIDC
 *    Auth bound to the workload's issuer where there is one, so no bearer
 *    token exists; else Token Auth), its project membership, and, for Token
 *    Auth, one token for this run.
 *
 * The owner never creates an identity or token, never sets an environment
 * variable and never types into a terminal.
 */

export interface WorkloadOidc {
	readonly discoveryUrl: string;
	readonly issuer: string;
	readonly audience: string;
	readonly subject: string;
}

export interface InfisicalAccessOptions {
	readonly family: "ci" | "cd";
	readonly projectId: string;
	readonly run: RunCommand;
	readonly which: (bin: string) => Promise<string | undefined>;
	readonly toolsDir: string;
	readonly fetch: typeof fetch;
	readonly emit: (line: string) => void;
	/** The owner is at this machine: the CLI's browser sign-in can complete. */
	readonly interactive: boolean;
	/** Infisical's origin; US cloud by default. */
	readonly apiOrigin?: string;
	/** The workload's OIDC issuer: OIDC Auth instead of a bearer token. */
	readonly workloadOidc?: WorkloadOidc;
	readonly exists?: (file: string) => boolean;
}

export type InfisicalAccess =
	| {
			readonly kind: "ready";
			readonly identityId: string;
			readonly auth: "oidc" | "token";
			/** Token Auth only: this run's token, for its vault. */
			readonly token: string | undefined;
	  }
	| {
			readonly kind: "refused";
			readonly code: string;
			readonly message: string;
			readonly remediation: readonly string[];
	  };

/** A JSON request body: strings, numbers and nested objects of them. */
type ApiBody = { readonly [key: string]: string | number | ApiBody };

const jwtPayload = z.object({ organizationId: z.string().min(1) });
const created = z.object({ identity: z.object({ id: z.string() }) });
const tokenCreated = z.object({ accessToken: z.string().min(1) });

/** The organization a user session token belongs to (its JWT payload). */
function organizationOf(jwt: string): string | undefined {
	const payload = jwt.split(".")[1];
	if (payload === undefined) return undefined;
	try {
		const parsed = jwtPayload.safeParse(
			JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
		);
		return parsed.success ? parsed.data.organizationId : undefined;
	} catch {
		return undefined;
	}
}

export async function provisionInfisicalAccess(
	options: InfisicalAccessOptions,
): Promise<InfisicalAccess> {
	const fam = options.family.toUpperCase();
	const refused = (
		code: string,
		message: string,
		remediation: readonly string[],
	): InfisicalAccess => ({
		kind: "refused",
		code: `HOBO_${fam}_INFISICAL_${code}`,
		message,
		remediation,
	});

	// 1. The CLI. A remote run with no CLI on the machine has no session to
	// reuse and cannot finish a browser sign-in: say so before installing.
	if (
		!options.interactive &&
		(await options.which(INFISICAL_CLI.bin)) === undefined &&
		!(options.exists ?? existsSync)(
			INFISICAL_CLI.installedPath(options.toolsDir),
		)
	)
		return refused(
			"SIGN_IN",
			"Infisical needs you to sign in once, and its browser sign-in returns to the machine you sign in from.",
			[
				"Run hobo up on your own machine once: HoBo installs Infisical's CLI, opens Infisical's sign-in in your browser, and sets up the rest.",
			],
		);
	let cli: string;
	try {
		cli = (
			await ensureStoreCli(INFISICAL_CLI, {
				run: options.run,
				which: options.which,
				toolsDir: options.toolsDir,
				...(options.exists !== undefined
					? { exists: options.exists }
					: undefined),
			})
		).command;
	} catch (error) {
		if (!(error instanceof StoreCliInstallError)) throw error;
		return refused("CLI_INSTALL", error.message, [
			"Run again: HoBo installs the Infisical CLI into its own tools directory.",
		]);
	}

	// 2. A user session: the existing one, else one sign-in.
	const signedIn = async () =>
		(await options.run(cli, ["login", "status"])).code === 0;
	if (!(await signedIn())) {
		if (!options.interactive)
			return refused(
				"SIGN_IN",
				"Infisical needs you to sign in once, and its browser sign-in returns to the machine running the CLI.",
				[
					"Run hobo up on your own machine once: HoBo installs Infisical's CLI, opens Infisical's sign-in in your browser, and sets up the rest.",
				],
			);
		options.emit("Opening Infisical's sign-in in your browser…");
		const login = await options.run(cli, ["login"], { interactive: true });
		if (login.code !== 0 || !(await signedIn()))
			return refused("SIGN_IN", "Signing in to Infisical did not complete.", [
				"Run again and finish signing in in the browser window Infisical opens.",
			]);
	}
	const session = (
		await options.run(cli, ["user", "get", "token", "--plain"])
	).stdout.trim();
	const organizationId = organizationOf(session);
	if (session === "" || organizationId === undefined)
		return refused("SESSION", "The Infisical CLI returned no usable session.", [
			"Run again; HoBo signs in to Infisical afresh.",
		]);

	// 3. The identity, its auth, its membership: through the API.
	const api = options.apiOrigin ?? "https://app.infisical.com";
	const call = async <T>(
		what: string,
		schema: z.ZodType<T>,
		pathname: string,
		body: ApiBody,
	): Promise<T> => {
		const response = await options.fetch(`${api}${pathname}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${session}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (!response.ok)
			throw new InfisicalApiRefusal(
				`Infisical refused ${what} (HTTP ${response.status}).`,
			);
		return schema.parse(await response.json());
	};
	try {
		const identity = await call(
			"creating the identity",
			created,
			"/api/v1/identities",
			{
				name: `hobo-${options.family}`,
				organizationId,
				role: "no-access",
			},
		);
		const identityId = identity.identity.id;
		const oidc = options.workloadOidc;
		if (oidc !== undefined)
			await call(
				"attaching OIDC Auth",
				z.unknown(),
				`/api/v1/auth/oidc-auth/identities/${identityId}`,
				{
					oidcDiscoveryUrl: oidc.discoveryUrl,
					boundIssuer: oidc.issuer,
					boundAudiences: oidc.audience,
					boundSubject: oidc.subject,
					boundClaims: {},
				},
			);
		else
			await call(
				"attaching Token Auth",
				z.unknown(),
				`/api/v1/auth/token-auth/identities/${identityId}`,
				{ accessTokenTTL: 3600, accessTokenMaxTTL: 3600 },
			);
		await call(
			"adding the identity to the project",
			z.unknown(),
			`/api/v1/projects/${options.projectId}/memberships/identities/${identityId}`,
			{ role: "member" },
		);
		if (oidc !== undefined)
			return { kind: "ready", identityId, auth: "oidc", token: undefined };
		const token = await call(
			"creating this run's token",
			tokenCreated,
			`/api/v1/auth/token-auth/identities/${identityId}/tokens`,
			{ name: `hobo ${options.family} up` },
		);
		return {
			kind: "ready",
			identityId,
			auth: "token",
			token: token.accessToken,
		};
	} catch (error) {
		if (!(error instanceof InfisicalApiRefusal)) throw error;
		return refused("API", error.message, [
			"Your Infisical account needs the right to manage machine identities in its organization and project.",
		]);
	}
}

class InfisicalApiRefusal extends Error {}
