import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";

import { z } from "zod";

import type { OwnerChannel } from "./owner-channel.js";
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

// public-contract: the prefix of the refusal line naming the sign-in link and the capture that carries its result.
export const OWNER_SIGN_IN_LINE_PREFIX = "HOBO_OWNER_SIGN_IN";

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
	/** How to reach an owner who is not at this machine (a remote dev box). */
	readonly owner?: OwnerChannel;
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

/** What Infisical's "Copy to clipboard" holds: base64 of its CLI login. */
const copiedLogin = z.object({ JTWToken: z.string().min(1) });

function sessionFromCopied(copied: string): string | undefined {
	try {
		const parsed = copiedLogin.safeParse(
			JSON.parse(Buffer.from(copied.trim(), "base64").toString("utf8")),
		);
		return parsed.success ? parsed.data.JTWToken : undefined;
	} catch {
		return undefined;
	}
}

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

	// 1. A user session. An existing CLI session on this machine first.
	const exists = options.exists ?? existsSync;
	const cliHere =
		(await options.which(INFISICAL_CLI.bin)) !== undefined
			? INFISICAL_CLI.bin
			: exists(INFISICAL_CLI.installedPath(options.toolsDir))
				? INFISICAL_CLI.installedPath(options.toolsDir)
				: undefined;
	const cliSession = async (cli: string) =>
		(await options.run(cli, ["login", "status"])).code === 0
			? (
					await options.run(cli, ["user", "get", "token", "--plain"])
				).stdout.trim()
			: undefined;
	let session = cliHere !== undefined ? await cliSession(cliHere) : undefined;

	if (session === undefined && options.interactive) {
		// 2. The owner is at this machine: the CLI's own browser sign-in.
		let cli: string;
		try {
			cli = (
				await ensureStoreCli(INFISICAL_CLI, {
					run: options.run,
					which: options.which,
					toolsDir: options.toolsDir,
					exists,
				})
			).command;
		} catch (error) {
			if (!(error instanceof StoreCliInstallError)) throw error;
			return refused("CLI_INSTALL", error.message, [
				"Run again: HoBo installs the Infisical CLI into its own tools directory.",
			]);
		}
		options.emit("Opening Infisical's sign-in in your browser…");
		const login = await options.run(cli, ["login"], { interactive: true });
		session = login.code === 0 ? await cliSession(cli) : undefined;
		if (session === undefined)
			return refused("SIGN_IN", "Signing in to Infisical did not complete.", [
				"Run again and finish signing in in the browser window Infisical opens.",
			]);
	} else if (session === undefined) {
		// 3. A remote box: no inbound connection, no tunnel. Infisical's
		// sign-in hands its session to 127.0.0.1 on the owner's own machine;
		// with nothing listening there it shows the session to copy ("Unable
		// to reach CLI"), and the owner hands it to this run through the
		// owner channel. The run needs no CLI for this.
		if (options.owner === undefined)
			return refused(
				"SIGN_IN",
				"Infisical needs you to sign in once, and this run has no way to reach you for it.",
				[
					"Run hobo up through the HoBo MCP server (its cd and ci tools), which brings Infisical's sign-in to you wherever you are.",
				],
			);
		const api = options.apiOrigin ?? "https://app.infisical.com";
		const signInUrl = `${api}/login?callback_port=${randomInt(20_000, 60_000)}`;
		await options.owner.openUrl(
			signInUrl,
			"Sign in to Infisical (your organization's SSO or MFA as usual). HoBo sets up its own access with this sign-in.",
		);
		const copied = await options.owner.captureSecret({
			name: "INFISICAL_CLI_SESSION",
			title: "Infisical sign-in",
			instructions:
				'After you sign in, Infisical says "Unable to reach CLI": click Copy to clipboard and paste it here. It goes only to this run, never into chat.',
		});
		if (copied === undefined)
			return refused(
				"SIGN_IN",
				"Sign in to Infisical once; this run sets up its own access with that sign-in.",
				[
					`${OWNER_SIGN_IN_LINE_PREFIX} url=${signInUrl} capture=INFISICAL_CLI_SESSION`,
					"Open the link on any device and sign in (SSO or MFA as your organization requires).",
					'Infisical then says "Unable to reach CLI": its Copy to clipboard copies your session. Hand it over with the HoBo MCP server\'s secret capture (name INFISICAL_CLI_SESSION); it goes only to this run.',
					"Then run again: HoBo creates its machine identity, access and project membership itself.",
				],
			);
		session = sessionFromCopied(copied);
		if (session === undefined)
			return refused(
				"SESSION",
				"What was pasted is not the session Infisical shows after signing in.",
				[
					'Run again; after signing in, use Infisical\'s "Copy to clipboard" button and paste exactly that.',
				],
			);
	}
	const organizationId =
		session === undefined ? undefined : organizationOf(session);
	if (session === undefined || session === "" || organizationId === undefined)
		return refused("SESSION", "Infisical returned no usable session.", [
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
