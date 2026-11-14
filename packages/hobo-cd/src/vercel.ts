import { randomBytes, timingSafeEqual } from "node:crypto";

import {
	type ConnectFlow,
	type ConnectStep,
	DEFAULT_SECRET_STORES,
	type FlowTransition,
	type SecretStoreOption,
} from "@hobo/connect-ui";
import type {
	OpenedSecretStore,
	SecretStoreId,
	SecretStoreOpening,
} from "@hobo/hobo-ci";
import { z } from "zod";

// The Vercel provider connection `hobo cd up` makes before it converges:
// HoBo CD's Vercel Integration installed on the owner's account or team
// (Vercel's integration authorization flow), the resulting access token
// deposited straight into the owner's secret store.
//
// Idempotent: a store that already holds the installation finishes at once
// as `unchanged`. Secretless: the integration's own client secret is read
// from the store for the one exchange (never from the environment or a
// file), the access token exists in memory between the exchange and the
// deposit, and the page sees references. Later runs verify the token and
// installation id before treating the connection as complete.

/** Deposit order: the installation id last, so its presence means complete. */
export const VERCEL_CONNECTION_KEYS = Object.freeze([
	"HOBO_CD_VERCEL_TOKEN",
	"HOBO_CD_VERCEL_TEAM_ID",
	"HOBO_CD_VERCEL_INSTALLATION_ID",
] as const);

/** The integration's client secret, kept in the store by the integration's owner. */
// public-contract: the store entry the integration's owner keeps its client secret in.
export const VERCEL_CLIENT_SECRET_KEY = "HOBO_CD_VERCEL_CLIENT_SECRET";

/** Vercel's token answer, parsed before any value is trusted. */
const TokenSchema = z.object({
	token_type: z.string(),
	access_token: z.string().min(1).max(4096),
	installation_id: z.string().regex(/^icfg_[A-Za-z0-9]{1,64}$/),
	user_id: z.string().regex(/^[A-Za-z0-9]{1,64}$/),
	team_id: z
		.string()
		.regex(/^team_[A-Za-z0-9]{1,64}$/)
		.nullable(),
});

const UserSchema = z.object({ user: z.object({ id: z.string() }) });

export interface VercelConnectOptions {
	/** The HoBo CD Integration's slug (vercel.com/integrations/<slug>). */
	readonly integrationSlug: string;
	readonly clientId: string;
	/** The Redirect URL registered on the Integration console. */
	readonly redirectUri: string;
	readonly stores?: readonly SecretStoreOption[];
	readonly openStore: (id: SecretStoreId) => Promise<SecretStoreOpening>;
	readonly fetch?: typeof fetch;
	readonly randomState?: () => string;
}

function failed(
	message: string,
	remediation: readonly string[],
): FlowTransition {
	return { step: { kind: "failed", provider: "vercel", message, remediation } };
}

/** True when the store already holds a complete Vercel connection. */
export async function vercelConnected(
	store: OpenedSecretStore,
): Promise<boolean> {
	const present = new Set<string>();
	for (const key of VERCEL_CONNECTION_KEYS) {
		let result: Awaited<ReturnType<typeof store.port.access>>;
		try {
			result = await store.port.access(key);
		} catch {
			throw new Error("Cannot inspect the existing Vercel connection.");
		}
		if (result.status === "ok" && result.material !== "") present.add(key);
		else if (result.status === "ok" || result.code !== "secret-not-found")
			throw new Error("Cannot inspect the existing Vercel connection.");
	}
	if (present.size === 0) return false;
	if (
		!present.has("HOBO_CD_VERCEL_TOKEN") ||
		!present.has("HOBO_CD_VERCEL_INSTALLATION_ID")
	)
		throw new Error("The stored Vercel connection is incomplete.");
	return true;
}

function connected(store: OpenedSecretStore): ConnectStep {
	return {
		kind: "connected",
		provider: "vercel",
		store: store.id,
		references: VERCEL_CONNECTION_KEYS.map((key) => store.reference(key)),
		nextHint: "hobo cd up continues in your terminal.",
		link: undefined,
	};
}

function sameState(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

/** The Vercel connection as a connect-page flow. */
export function createVercelConnectFlow(
	options: VercelConnectOptions,
): ConnectFlow & {
	readonly outcome: () => "created" | "unchanged" | undefined;
} {
	const send = options.fetch ?? fetch;
	let store: OpenedSecretStore | undefined;
	let state: string | undefined;
	let outcome: "created" | "unchanged" | undefined;

	return {
		initial: {
			kind: "choose-secret-store",
			provider: "vercel",
			stores: options.stores ?? DEFAULT_SECRET_STORES,
		},
		outcome: () => outcome,

		async onAction(action, params, current) {
			if (action === "connect.cancel")
				return failed(
					"Connection cancelled; an installation may already exist on Vercel.",
					[
						"Check Vercel and the secret store for a partial setup before retrying.",
					],
				);
			if (action === "connect.chooseStore") {
				if (current.kind !== "choose-secret-store") return { step: current };
				const choice = (options.stores ?? DEFAULT_SECRET_STORES).find(
					(option) => option.id === params.store,
				);
				if (choice === undefined)
					return failed("That secret store is not offered.", []);
				const opened = await options.openStore(choice.id);
				if (!opened.ok) return failed(opened.message, opened.remediation);
				store = opened.store;
				let alreadyConnected: boolean;
				try {
					alreadyConnected = await vercelConnected(store);
				} catch {
					return failed("Cannot verify the existing Vercel connection.", [
						"Check access and reconcile any partial credentials in the secret store before retrying.",
					]);
				}
				if (alreadyConnected) {
					outcome = "unchanged";
					return { step: connected(store) };
				}
				return {
					step: {
						kind: "authorize-vercel",
						provider: "vercel",
						team: undefined,
						store: store.id,
					},
				};
			}
			if (current.kind !== "authorize-vercel" || store === undefined)
				return { step: current };
			state = (
				options.randomState ?? (() => randomBytes(32).toString("base64url"))
			)();
			const install = new URL(
				`https://vercel.com/integrations/${encodeURIComponent(options.integrationSlug)}/new`,
			);
			install.searchParams.set("state", state);
			return {
				step: current,
				directive: { kind: "navigate", url: install.href },
			};
		},

		async onCallback(query, current) {
			if (
				current.kind !== "authorize-vercel" ||
				store === undefined ||
				state === undefined
			)
				return { step: current };
			const code = query.get("code");
			const returned = query.get("state");
			// The Redirect URL is fixed and public on the loopback, so the state
			// is what ties this answer to this connection.
			if (code === null || returned === null || !sameState(returned, state))
				return failed("Vercel's answer did not match this connection.", [
					"Run hobo cd up again; nothing was stored.",
				]);
			state = undefined;

			const secret = await store.port
				.access(VERCEL_CLIENT_SECRET_KEY)
				.catch(() => undefined);
			if (secret?.status !== "ok" || secret.material === undefined)
				return failed(`HoBo CD's integration secret is not in ${store.id}.`, [
					`The integration's owner stores its client secret once as ${VERCEL_CLIENT_SECRET_KEY} in ${store.id}; then run hobo cd up again.`,
				]);

			let token: z.infer<typeof TokenSchema>;
			try {
				const response = await send(
					"https://api.vercel.com/v2/oauth/access_token",
					{
						method: "POST",
						headers: { "content-type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							client_id: options.clientId,
							client_secret: secret.material,
							code,
							redirect_uri: options.redirectUri,
						}),
						redirect: "error",
						signal: AbortSignal.timeout(15_000),
					},
				);
				if (!response.ok) throw new Error("exchange refused");
				token = TokenSchema.parse(await response.json());
			} catch {
				return failed("Vercel's code exchange failed or could not be read.", [
					"The code is single-use and valid for 30 minutes; run hobo cd up again.",
				]);
			}
			// The token must act as the user Vercel said installed it.
			try {
				const response = await send("https://api.vercel.com/v2/user", {
					headers: { authorization: `Bearer ${token.access_token}` },
					redirect: "error",
					signal: AbortSignal.timeout(15_000),
				});
				if (!response.ok) throw new Error("user refused");
				const user = UserSchema.parse(await response.json());
				if (user.user.id !== token.user_id) throw new Error("user mismatch");
			} catch {
				return failed("Vercel's token did not verify; it was discarded.", [
					"Remove the integration from your Vercel account's Integrations page and run hobo cd up again.",
				]);
			}

			const values = {
				HOBO_CD_VERCEL_TOKEN: token.access_token,
				HOBO_CD_VERCEL_TEAM_ID: token.team_id ?? "",
				HOBO_CD_VERCEL_INSTALLATION_ID: token.installation_id,
			} satisfies Readonly<
				Record<(typeof VERCEL_CONNECTION_KEYS)[number], string>
			>;
			for (const key of VERCEL_CONNECTION_KEYS) {
				// A personal-account installation has no team.
				if (values[key] === "") continue;
				try {
					await store.port.put(key, values[key]);
				} catch {
					return failed(
						`The ${store.id} write failed; the rest was discarded.`,
						[`Fix access to ${store.id} and run hobo cd up again.`],
					);
				}
			}
			outcome = "created";
			return { step: connected(store) };
		},
	};
}
