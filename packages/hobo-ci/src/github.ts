import { randomBytes, timingSafeEqual } from "node:crypto";

import {
	createGithubAppManifest,
	githubAppManifestJson,
	verifyConvertedGithubApp,
} from "@hobo/ci-gh-actions";
import {
	type ConnectFlow,
	type ConnectStep,
	DEFAULT_SECRET_STORES,
	type FlowTransition,
	type SecretStoreOption,
} from "@hobo/connect-ui";
import { z } from "zod";

import type {
	OpenedSecretStore,
	SecretStoreId,
	SecretStoreOpening,
} from "./secret-stores.js";

// The GitHub provider connection `hobo ci up` makes before it converges: a
// GitHub App created from HoBo's reviewed manifest (GitHub's App manifest
// flow), its credentials deposited straight from GitHub's one-time
// conversion into the owner's secret store.
//
// Idempotent: choosing a store that already holds the App's id finishes at
// once as `unchanged` — re-running `hobo ci up` never creates a second App.
// Secretless: the credentials exist in this process's memory between the
// conversion and the deposit, and nowhere else. The page sees store
// references. The deposit writes the App id last, so its presence means
// every other entry is there too.

/** Deposit order: the App id last, so its presence means complete. */
export const GITHUB_APP_CREDENTIAL_KEYS = Object.freeze([
	"HOBO_CI_GITHUB_APP_PRIVATE_KEY",
	"HOBO_CI_WEBHOOK_SECRET",
	"HOBO_CI_GITHUB_APP_CLIENT_SECRET",
	"HOBO_CI_GITHUB_APP_CLIENT_ID",
	"HOBO_CI_GITHUB_APP_ID",
] as const);

type CredentialKey = (typeof GITHUB_APP_CREDENTIAL_KEYS)[number];

const COMPLETE_MARKER: CredentialKey = "HOBO_CI_GITHUB_APP_ID";

/** GitHub's conversion answer, parsed before any value is trusted. */
const ConversionSchema = z.object({
	id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	slug: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
	pem: z.string().min(1).max(32_768),
	webhook_secret: z.string().min(1).max(1024),
	client_id: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
	client_secret: z.string().min(1).max(256),
});

export interface GithubConnectOptions {
	/** The hosted relay's public HTTPS origin (webhooks go there). */
	readonly relayUrl: string;
	/** The numeric id of the GitHub user the App must belong to. */
	readonly ownerId: number;
	/** Shown on the page and used in GitHub's create screen. */
	readonly owner: string;
	readonly appName?: string;
	/** Where GitHub sends the browser back (the connect page's callback). */
	readonly callbackUrl: () => string;
	readonly stores?: readonly SecretStoreOption[];
	readonly openStore: (id: SecretStoreId) => Promise<SecretStoreOpening>;
	readonly fetch?: typeof fetch;
	readonly randomState?: () => string;
}

function failed(
	message: string,
	remediation: readonly string[],
): FlowTransition {
	return { step: { kind: "failed", provider: "github", message, remediation } };
}

/** True when the store already holds a complete App connection. */
export async function githubAppConnected(
	store: OpenedSecretStore,
): Promise<boolean> {
	try {
		const result = await store.port.access(COMPLETE_MARKER);
		return result.status === "ok";
	} catch {
		return false;
	}
}

function connected(
	store: OpenedSecretStore,
	slug: string | undefined,
): ConnectStep {
	return {
		kind: "connected",
		provider: "github",
		store: store.id,
		references: GITHUB_APP_CREDENTIAL_KEYS.map((key) => store.reference(key)),
		nextHint: "hobo ci up continues in your terminal.",
		link:
			slug === undefined
				? undefined
				: {
						label: "Install the App on your repositories",
						href: `https://github.com/apps/${slug}/installations/new`,
					},
	};
}

function sameState(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

/** The GitHub connection as a connect-page flow. */
export function createGithubConnectFlow(
	options: GithubConnectOptions,
): ConnectFlow & {
	/** How the last transition ended, for the lifecycle's prepare report. */
	readonly outcome: () => "created" | "unchanged" | undefined;
} {
	const send = options.fetch ?? fetch;
	const appName = options.appName ?? "HoBo CI";
	let store: OpenedSecretStore | undefined;
	let state: string | undefined;
	let outcome: "created" | "unchanged" | undefined;

	return {
		initial: {
			kind: "choose-secret-store",
			provider: "github",
			stores: options.stores ?? DEFAULT_SECRET_STORES,
		},
		outcome: () => outcome,

		async onAction(action, params, current) {
			if (action === "connect.cancel")
				return failed("Cancelled. Nothing was created on GitHub.", [
					"Run hobo ci up again when you are ready.",
				]);
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
				if (await githubAppConnected(store)) {
					outcome = "unchanged";
					return { step: connected(store, undefined) };
				}
				return {
					step: {
						kind: "create-github-app",
						provider: "github",
						appName,
						owner: options.owner,
						store: store.id,
					},
				};
			}
			// connect.start: post the reviewed manifest to GitHub.
			if (current.kind !== "create-github-app" || store === undefined)
				return { step: current };
			state = (
				options.randomState ?? (() => randomBytes(32).toString("base64url"))
			)();
			const manifest = createGithubAppManifest({
				name: appName,
				relayUrl: options.relayUrl,
				manifestCallbackUrl: `${options.relayUrl}/v1/app-bootstrap/callback`,
				installationCallbackUrl: `${options.relayUrl}/v1/app-registration/install-callback`,
			});
			// GitHub sends the browser back to this machine, not to the relay.
			manifest.redirectUrl = options.callbackUrl();
			// A user-owned App: the reviewed verifier (verifyConvertedGithubApp)
			// accepts only `owner.type: "User"`, so an organization-owned App
			// would be created and then always refused.
			const action_ = new URL("https://github.com/settings/apps/new");
			action_.searchParams.set("state", state);
			return {
				step: current,
				directive: {
					kind: "post",
					url: action_.href,
					fields: { manifest: githubAppManifestJson(manifest) },
				},
			};
		},

		async onCallback(query, current) {
			if (
				current.kind !== "create-github-app" ||
				store === undefined ||
				state === undefined
			)
				return { step: current };
			const code = query.get("code");
			const returned = query.get("state");
			if (code === null || returned === null || !sameState(returned, state))
				return failed("GitHub's answer did not match this connection.", [
					"Run hobo ci up again; no App credentials were stored.",
				]);
			state = undefined;

			// The one-time conversion: from here the credentials are in memory only.
			let conversion: z.infer<typeof ConversionSchema>;
			let metadata: z.core.util.JSONType;
			try {
				const response = await send(
					`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
					{
						method: "POST",
						headers: {
							accept: "application/vnd.github+json",
							"x-github-api-version": "2026-03-10",
						},
						redirect: "error",
						signal: AbortSignal.timeout(15_000),
					},
				);
				if (response.status !== 201 && response.status !== 200)
					throw new Error("conversion refused");
				metadata = await response.json();
				conversion = ConversionSchema.parse(metadata);
			} catch {
				return failed(
					"GitHub's manifest conversion failed or could not be read. The App may exist.",
					[
						"Check https://github.com/settings/apps, delete an App HoBo did not finish, and run hobo ci up again.",
					],
				);
			}
			const deleteUrl = `https://github.com/settings/apps/${conversion.slug}/advanced`;
			try {
				await verifyConvertedGithubApp({
					appId: conversion.id,
					pem: conversion.pem,
					metadata,
					expectedOrigin: options.relayUrl,
					expectedOwnerId: options.ownerId,
					fetch: send,
				});
			} catch {
				return failed(
					`GitHub App ${conversion.slug} does not match the reviewed configuration; its credentials were discarded.`,
					[`Delete it at ${deleteUrl}, then run hobo ci up again.`],
				);
			}

			const values = {
				HOBO_CI_GITHUB_APP_PRIVATE_KEY: conversion.pem,
				HOBO_CI_WEBHOOK_SECRET: conversion.webhook_secret,
				HOBO_CI_GITHUB_APP_CLIENT_SECRET: conversion.client_secret,
				HOBO_CI_GITHUB_APP_CLIENT_ID: conversion.client_id,
				HOBO_CI_GITHUB_APP_ID: String(conversion.id),
			} satisfies Readonly<Record<CredentialKey, string>>;
			const stored: string[] = [];
			for (const key of GITHUB_APP_CREDENTIAL_KEYS) {
				try {
					await store.port.put(key, values[key]);
					stored.push(key);
				} catch {
					return failed(
						`The ${store.id} write failed after ${stored.length} of ${GITHUB_APP_CREDENTIAL_KEYS.length} entries; the rest were discarded.`,
						[
							`Delete the App at ${deleteUrl}, fix access to ${store.id}, and run hobo ci up again.`,
						],
					);
				}
			}
			outcome = "created";
			return { step: connected(store, conversion.slug) };
		},
	};
}
