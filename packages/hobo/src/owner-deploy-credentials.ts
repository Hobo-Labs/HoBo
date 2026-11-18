import { createTrustedVault, type TrustedVault } from "@hobo/core";
import {
	KEPT_STORE_SIGN_INS,
	lazyEgressFetch,
	loadDeployCredentials,
	type OwnerSettingsStore,
	type OwnerStore,
	type OwnerStoreDeps,
	ownerStore,
	ownerStoreSessionEnvironment,
} from "@hobo/hobo-ci";
import { ownerStoreEnvironment } from "./owner-store-env.js";

export async function loadOwnerDeployCredentials(input: {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly credentials: TrustedVault;
	readonly ownerSession?: TrustedVault;
	readonly ownerSettings?: OwnerSettingsStore;
	readonly fetch?: typeof fetch;
	readonly openStore?: OwnerStoreDeps["openStore"];
	readonly open?: (
		session: TrustedVault,
		cwd: string,
	) => Promise<Pick<OwnerStore, "chosen" | "opened">>;
}): Promise<boolean> {
	if (input.credentials.has("VERCEL_TOKEN")) return true;
	const session = createTrustedVault();
	try {
		const storeEnv = await ownerStoreSessionEnvironment(
			{
				...(input.ownerSettings ? { locator: input.ownerSettings } : undefined),
				cwd: input.cwd,
			},
			input.env,
		);
		const env = ownerStoreEnvironment(storeEnv);
		for (const name of KEPT_STORE_SIGN_INS) {
			const value = input.ownerSession?.reveal(name);
			if (value) session.put(name, value);
		}
		const selected = input.open
			? await input.open(session, input.cwd)
			: await ownerStore("cd", session, {
					cwd: input.cwd,
					env,
					workloadOidc: input.env,
					...(input.openStore ? { openStore: input.openStore } : undefined),
					...(input.ownerSettings
						? { locator: input.ownerSettings }
						: undefined),
					fetch: input.fetch ?? lazyEgressFetch(input.env),
				});
		if (!selected.chosen || !selected.opened) return false;
		await loadDeployCredentials(selected.opened, input.credentials);
		input.ownerSettings?.assertCurrent?.();
		return input.credentials.has("VERCEL_TOKEN");
	} catch {
		input.credentials.drop("VERCEL_TOKEN");
		input.credentials.drop("VERCEL_TEAM_ID");
		return false;
	} finally {
		session.clear();
	}
}
