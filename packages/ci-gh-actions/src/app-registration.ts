import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { OnboardingGithubPort } from "./onboarding.js";

const Principal = z.object({
	accountId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
	subject: z.string().min(1).max(200),
});
const State = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Code = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Conversion = z.object({
	id: Id,
	owner: z.object({ id: Id, type: z.string() }).optional(),
	pem: z.string().min(1),
	webhook_secret: z.string().min(1),
	client_id: z.string().min(1),
	client_secret: z.string().min(1),
});
const Installation = z.object({
	id: Id,
	app_id: Id,
	suspended_at: z.null(),
});
type Actor = z.infer<typeof Principal>;
type Purpose = "register" | "install";

/** Must atomically bind a state digest to its identity and consume it once. */
export interface AppRegistrationStatePort {
	issue(
		digest: string,
		purpose: Purpose,
		actor: Actor,
		expiresAt: number,
	): Promise<void>;
	consume(
		digest: string,
		purpose: Purpose,
		actor: Actor,
		now: number,
	): Promise<boolean>;
}

/** Implementations authenticate the HoBo session, then verify GitHub admin authority. */
export interface AppRegistrationAuthorityPort {
	authorize(actor: Actor, purpose: Purpose): Promise<boolean>;
	verifyInstallationAdmin(
		actor: Actor,
		installationId: number,
	): Promise<boolean>;
}

/** Both methods must enforce unique ownership transactionally. Never log secret input. */
export interface AppRegistrationVaultPort {
	saveApp(
		appId: number,
		credentials: {
			pem: string;
			webhookSecret: string;
			clientId: string;
			clientSecret: string;
		},
	): Promise<void>;
	bindInstallation(
		appId: number,
		installationId: number,
		accountId: string,
	): Promise<void>;
}

/** Conversion may have succeeded remotely; a spent code must never be retried blindly. */
export class AppRegistrationUncertainError extends Error {
	constructor() {
		super("GitHub App conversion outcome uncertain; reconcile before retrying");
	}
}

/** The one-use code was converted, but GitHub reported an unexpected owner. */
export class AppRegistrationOwnerMismatchError extends Error {
	constructor() {
		super("GitHub App owner does not match the configured owner");
	}
}

/** Compose authenticated callbacks using a durable one-time state store and vault. */
export function createAppRegistration(options: {
	states: AppRegistrationStatePort;
	authority: AppRegistrationAuthorityPort;
	vault: AppRegistrationVaultPort;
	github: OnboardingGithubPort;
	appId?: number | undefined;
	expectedGithubOwnerId?: number | undefined;
	/** Called only after the owner pin succeeds, before an App can be activated. */
	verifyConvertedApp?:
		| ((input: {
				appId: number;
				metadata: unknown;
				credentials: {
					pem: string;
					webhookSecret: string;
					clientId: string;
					clientSecret: string;
				};
		  }) => Promise<void>)
		| undefined;
	fetch?: typeof fetch;
	now?: () => number;
}) {
	const appId =
		options.appId === undefined ? undefined : Id.parse(options.appId);
	const ownerId =
		options.expectedGithubOwnerId === undefined
			? undefined
			: Id.parse(options.expectedGithubOwnerId);
	if (ownerId !== undefined && !options.verifyConvertedApp)
		throw new Error("owner-pinned registration requires App verification");
	const now = options.now ?? Date.now;
	const send = options.fetch ?? fetch;
	const digest = (state: string) =>
		createHash("sha256").update(state).digest("hex");
	async function actor(input: Actor, purpose: Purpose) {
		const parsed = Principal.parse(input);
		if (!(await options.authority.authorize(parsed, purpose)))
			throw new Error("not authorized");
		return parsed;
	}
	async function consume(input: Actor, purpose: Purpose, state: string) {
		const principal = await actor(input, purpose);
		const value = State.parse(state);
		if (
			!(await options.states.consume(digest(value), purpose, principal, now()))
		)
			throw new Error("invalid or expired state");
		return principal;
	}
	return {
		async begin(input: Actor, purpose: Purpose): Promise<string> {
			const principal = await actor(input, purpose);
			const state = randomBytes(32).toString("base64url");
			await options.states.issue(
				digest(state),
				purpose,
				principal,
				now() + 10 * 60_000,
			);
			return state;
		},
		async completeRegistration(
			input: Actor,
			state: string,
			code: string,
		): Promise<{ appId: number }> {
			const parsedCode = Code.parse(code);
			await consume(input, "register", state);
			try {
				const response = await send(
					`https://api.github.com/app-manifests/${parsedCode}/conversions`,
					{
						method: "POST",
						headers: {
							Accept: "application/vnd.github+json",
							"X-GitHub-Api-Version": "2026-03-10",
						},
						redirect: "error",
						signal: AbortSignal.timeout(15000),
					},
				);
				if (!response.ok) throw new Error("conversion failed");
				const metadata: unknown = await response.json();
				const result = Conversion.parse(metadata);
				if (appId !== undefined && result.id !== appId)
					throw new Error("unexpected App identity");
				if (
					ownerId !== undefined &&
					(result.owner?.id !== ownerId || result.owner.type !== "User")
				)
					throw new AppRegistrationOwnerMismatchError();
				const credentials = {
					pem: result.pem,
					webhookSecret: result.webhook_secret,
					clientId: result.client_id,
					clientSecret: result.client_secret,
				};
				await options.verifyConvertedApp?.({
					appId: result.id,
					metadata,
					credentials,
				});
				await options.vault.saveApp(result.id, credentials);
				return { appId: result.id };
			} catch (error) {
				if (error instanceof AppRegistrationOwnerMismatchError) throw error;
				throw new AppRegistrationUncertainError();
			}
		},
		async completeInstallation(
			input: Actor,
			state: string,
			installationId: number,
		): Promise<{ installationId: number }> {
			const id = Id.parse(installationId);
			if (appId === undefined)
				throw new Error("registered App identity required");
			const principal = await consume(input, "install", state);
			if (!(await options.authority.verifyInstallationAdmin(principal, id)))
				throw new Error("GitHub administrator authority required");
			const response = await options.github.appRequest(
				`/app/installations/${id}`,
			);
			if (!response.ok) throw new Error("installation verification failed");
			const installation = Installation.parse(await response.json());
			if (installation.id !== id || installation.app_id !== appId)
				throw new Error("installation belongs to another App");
			await options.vault.bindInstallation(appId, id, principal.accountId);
			return { installationId: id };
		},
	};
}
