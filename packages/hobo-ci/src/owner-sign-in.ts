import type { TrustedVault } from "@hobo/core";

import { ensureBitwardenSignIn } from "./bitwarden-sign-in.js";
import {
	DEFAULT_INFISICAL_ENVIRONMENT,
	provisionInfisicalAccess,
} from "./infisical-access.js";
import { provisionOnePasswordAccess } from "./onepassword-access.js";
import { KEPT_STORE_SIGN_INS } from "./owner-channel.js";
import {
	type OwnerStore,
	type OwnerStoreDeps,
	ownerLocator,
} from "./owner-store.js";
import type { Env } from "./secret-stores.js";
import { hoboToolsDir } from "./store-cli.js";

export type OwnerSignInRefusal = Readonly<{
	kind: "refused";
	code: string;
	message: string;
	remediation: readonly string[];
}>;

export type OwnerSignInOutcome =
	| Readonly<{ kind: "owner"; owner: OwnerStore }>
	| OwnerSignInRefusal;

export interface OwnerSignInDeps extends OwnerStoreDeps {
	readonly sleep?: (ms: number) => Promise<void>;
	readonly handOffTimeoutMs?: number;
}

export interface OwnerSignInInput {
	readonly family: "ci" | "cd";
	readonly vault: TrustedVault;
	readonly open: (resolved?: Env) => Promise<OwnerStore>;
	readonly deps: OwnerSignInDeps;
	readonly plainEnv: Env;
	readonly workloadOidc: OwnerStoreDeps["workloadOidc"];
	readonly whatIf: boolean;
	readonly handOff: boolean;
	readonly silent: boolean;
	readonly emit: (line: string) => void;
}

const refusedWith = (refusal: {
	readonly code: string;
	readonly message: string;
	readonly remediation: readonly string[];
}): OwnerSignInRefusal => ({ kind: "refused", ...refusal });

export async function signInOwnerStore(
	input: OwnerSignInInput,
): Promise<OwnerSignInOutcome> {
	const { deps, vault, plainEnv, family } = input;
	const kept = deps.ownerChannel?.vault;
	const restored = KEPT_STORE_SIGN_INS.filter((name) => {
		const value = kept?.reveal(name);
		if (value === undefined || vault.has(name)) return false;
		vault.put(name, value);
		return true;
	});
	let owner = await input.open();
	if (owner.opened === undefined && restored.length > 0) {
		for (const name of restored) {
			vault.drop(name);
			kept?.drop(name);
		}
		owner = await input.open();
	}
	if (!owner.chosen || input.whatIf || owner.opened !== undefined)
		return { kind: "owner", owner };
	const locator = ownerLocator(deps);
	if (
		owner.id === "infisical" &&
		deps.runCommand !== undefined &&
		!vault.has("INFISICAL_TOKEN") &&
		input.workloadOidc === undefined &&
		!plainEnv.INFISICAL_SIGN_IN &&
		!(await locator.read()).INFISICAL_SIGN_IN
	) {
		const saved = await locator.read();
		const projectId =
			plainEnv.INFISICAL_PROJECT_ID || saved.INFISICAL_PROJECT_ID;
		const access = await (deps.infisicalAccess ?? provisionInfisicalAccess)({
			family,
			...(projectId ? { projectId } : undefined),
			run: deps.runCommand,
			which: deps.which ?? (async () => undefined),
			toolsDir: hoboToolsDir(),
			fetch: deps.fetch ?? fetch,
			emit: input.emit,
			interactive: !input.handOff,
			apiOrigin:
				plainEnv.INFISICAL_SITE_URL ??
				saved.INFISICAL_SITE_URL ??
				"https://app.infisical.com",
			...(deps.ownerChannel !== undefined
				? { owner: deps.ownerChannel }
				: undefined),
			...(owner.infisicalFolder !== undefined
				? { folder: owner.infisicalFolder }
				: undefined),
		});
		if (access.kind === "refused") return refusedWith(access);
		if (access.token !== undefined) vault.put("INFISICAL_TOKEN", access.token);
		const { INFISICAL_ENVIRONMENT: _previous, ...settings } =
			await locator.read();
		const resolved = {
			INFISICAL_PROJECT_ID: access.projectId,
			INFISICAL_ENVIRONMENT: access.environment,
		};
		await locator.write({
			...settings,
			INFISICAL_IDENTITY_ID: access.identityId,
			INFISICAL_PROJECT_ID: access.projectId,
			...(access.environment !== DEFAULT_INFISICAL_ENVIRONMENT
				? { INFISICAL_ENVIRONMENT: access.environment }
				: undefined),
		});
		owner = await input.open(resolved);
	}
	if (
		owner.id === "1password" &&
		deps.runCommand !== undefined &&
		owner.opened === undefined &&
		!vault.has("OP_SERVICE_ACCOUNT_TOKEN") &&
		!plainEnv.OP_ACCOUNT &&
		!plainEnv.OP_CONNECT_HOST
	) {
		const saved = await locator.read();
		const vaultId = plainEnv.OP_VAULT_ID ?? saved.OP_VAULT_ID;
		const signInAddress =
			plainEnv.OP_SIGN_IN_ADDRESS ?? saved.OP_SIGN_IN_ADDRESS;
		if (
			vaultId !== undefined &&
			vaultId !== "" &&
			!saved.OP_ACCOUNT &&
			!saved.OP_CONNECT_HOST
		) {
			const access = await (
				deps.onePasswordAccess ?? provisionOnePasswordAccess
			)({
				family,
				vaultId,
				run: deps.runCommand,
				which: deps.which ?? (async () => undefined),
				toolsDir: hoboToolsDir(),
				emit: input.emit,
				interactive: !input.handOff,
				...(deps.ownerChannel !== undefined
					? { owner: deps.ownerChannel }
					: undefined),
				...(signInAddress ? { signInAddress } : undefined),
			});
			if (access.kind === "refused") return refusedWith(access);
			vault.put("OP_SERVICE_ACCOUNT_TOKEN", access.token);
			owner = await input.open();
		}
	}
	if (owner.id === "bitwarden" && owner.opened === undefined) {
		const refusal = await ensureBitwardenSignIn({
			family,
			vault,
			env: plainEnv,
			locator,
			fetch: deps.fetch ?? fetch,
			emit: input.emit,
			silent: input.silent,
			handOff: input.handOff,
			...(deps.ownerChannel !== undefined
				? { owner: deps.ownerChannel }
				: undefined),
			...(deps.sleep !== undefined ? { sleep: deps.sleep } : undefined),
			...(deps.handOffTimeoutMs !== undefined
				? { timeoutMs: deps.handOffTimeoutMs }
				: undefined),
		});
		if (refusal !== undefined) return refusedWith(refusal);
		owner = await input.open();
	}
	return { kind: "owner", owner };
}
