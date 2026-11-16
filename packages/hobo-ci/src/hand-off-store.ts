import type { OwnerStore } from "./owner-store.js";

/**
 * The store side of an owner hand-off, with post-back.
 *
 * A handed-off run (an agent's remote box) shows no page, so the owner signs
 * the run in out of band: they give the agent's session an Infisical access
 * token in its credential form, and the session's egress proxy injects it on
 * the way to Infisical (`INFISICAL_SIGN_IN=egress-proxy`). Nothing calls this
 * machine back. Instead the run names what it needs on one
 * `HOBO_OWNER_CREDENTIAL` line, then polls the store until it answers with
 * the owner's credential, and carries on in the same run. Only a store that
 * answers a read counts as signed in: a placeholder the proxy has not replaced
 * yet is refused by Infisical, and the run keeps waiting.
 */

// public-contract: the prefix of the one progress line naming the credential a handed-off run waits for.
export const OWNER_CREDENTIAL_LINE_PREFIX = "HOBO_OWNER_CREDENTIAL";
// public-contract: 1Password's guide to the Connect server and the access token a handed-off run needs.
export const ONE_PASSWORD_CONNECT_GUIDE = "https://www.1password.dev/connect/";
// public-contract: Infisical's guide to the Token Auth identity the owner creates for a handed-off run.
export const INFISICAL_TOKEN_AUTH_GUIDE =
	"https://infisical.com/docs/documentation/platform/identities/token-auth";

/** The entry a probe reads: the lifecycle's own settings, present or not. */
function probeEntry(family: "ci" | "cd"): string {
	return `HOBO_${family.toUpperCase()}_SETTINGS`;
}

/** True when the store answers a read with the run's sign-in. */
export async function storeAnswers(
	owner: OwnerStore,
	family: "ci" | "cd",
): Promise<boolean> {
	if (owner.opened === undefined) return false;
	const read = await owner.opened.port
		.access(probeEntry(family))
		.catch(() => undefined);
	return (
		read !== undefined &&
		(read.status === "ok" || read.code === "secret-not-found")
	);
}

/** What the owner gives, for the store they chose, and where. */
function credentialLine(
	owner: OwnerStore,
	family: "ci" | "cd",
	timeoutMs: number,
): string {
	const host =
		owner.egressCredentialHost !== undefined
			? new URL(owner.egressCredentialHost).host
			: "app.infisical.com";
	const wait = `This run waits ${Math.round(timeoutMs / 60_000)} minutes and continues on its own.`;
	if (owner.id === "1password")
		return `${OWNER_CREDENTIAL_LINE_PREFIX} host=${host} guide=${ONE_PASSWORD_CONNECT_GUIDE} — in 1Password: Developer → Connect servers → your server → Issue token, with access to the store's vault only. Then give the token to the agent's session in its credential form for ${host}, never in chat. ${wait}`;
	return `${OWNER_CREDENTIAL_LINE_PREFIX} host=${host} guide=${INFISICAL_TOKEN_AUTH_GUIDE} — at https://app.infisical.com: Organization → Access Control → Identities → Create Identity "hobo-${family}-owner" (organization role No Access); add Token Auth and create a token (TTL 3600); add the identity to the store's project with a write role. Then give the token to the agent's session in its credential form for ${host}, never in chat. ${wait}`;
}

export interface HandOffStoreOptions {
	readonly family: "ci" | "cd";
	/** Find and open the owner's store again (the sign-in may have arrived). */
	readonly open: () => Promise<OwnerStore>;
	readonly emit: (line: string) => void;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	readonly timeoutMs?: number;
	readonly intervalMs?: number;
}

/**
 * Wait, in this run, for the owner's out-of-band sign-in. Returns the store
 * once it answers; otherwise, at the deadline, the owner store as not opened,
 * so the caller refuses with every path.
 */
export async function awaitHandOffStore(
	options: HandOffStoreOptions,
): Promise<OwnerStore> {
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? 15 * 60_000;
	const deadline = now() + timeoutMs;
	let owner = await options.open();
	if (await storeAnswers(owner, options.family)) return owner;
	// A proxy credential cannot repair missing coordinates or another sign-in.
	if (!owner.canAwaitEgressCredential) return { ...owner, opened: undefined };
	options.emit(credentialLine(owner, options.family, timeoutMs));
	while (now() < deadline) {
		await sleep(options.intervalMs ?? 10_000);
		owner = await options.open();
		if (await storeAnswers(owner, options.family)) return owner;
		if (!owner.canAwaitEgressCredential) return { ...owner, opened: undefined };
	}
	return { ...owner, opened: undefined };
}
