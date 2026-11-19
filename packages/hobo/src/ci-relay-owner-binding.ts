import {
	parseInfisicalBinding,
	parseInfisicalIdentityId,
} from "@hobo/adapter-infisical";
import { createTrustedVault, type TrustedVault } from "@hobo/core";
import {
	KEPT_STORE_SIGN_INS,
	lazyEgressFetch,
	type OwnerSettingsStore,
	type OwnerStore,
	ownerStore,
	ownerStoreSessionEnvironment,
} from "@hobo/hobo-ci";
import { isJsonObject, isJsonString, parseJsonObject } from "./json.js";
import { ownerStoreEnvironment } from "./owner-store-env.js";

const RELAY_RUNTIME_BINDING_ENTRY = "HOBO_CI_RELAY_RUNTIME_BINDING";

type RelayRuntimeBinding = Readonly<{
	siteUrl: string;
	projectId: string;
	identityId: string;
	environment: string;
	secretPath: string;
}>;

export type OwnerRelayBinding =
	| { readonly kind: "ready"; readonly binding: RelayRuntimeBinding }
	| { readonly kind: "missing" | "invalid" | "mismatch" | "unavailable" };

export async function readOwnerRelayBinding(input: {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly teamId: string;
	readonly projectId: string;
	readonly ownerSession?: TrustedVault;
	readonly ownerSettings?: OwnerSettingsStore;
	readonly fetch?: typeof fetch;
	readonly open?: (
		session: TrustedVault,
		cwd: string,
	) => Promise<Pick<OwnerStore, "chosen" | "opened">>;
}): Promise<OwnerRelayBinding> {
	const session = createTrustedVault();
	try {
		for (const name of KEPT_STORE_SIGN_INS) {
			const value = input.ownerSession?.reveal(name);
			if (value) session.put(name, value);
		}
		input.ownerSettings?.assertCurrent?.();
		const selected = input.open
			? await input.open(session, input.cwd)
			: await ownerStore("ci", session, {
					cwd: input.cwd,
					env: ownerStoreEnvironment(
						await ownerStoreSessionEnvironment(
							{
								cwd: input.cwd,
								...(input.ownerSettings
									? { locator: input.ownerSettings }
									: undefined),
							},
							input.env,
						),
					),
					workloadOidc: input.env,
					...(input.ownerSettings
						? { locator: input.ownerSettings }
						: undefined),
					fetch: input.fetch ?? lazyEgressFetch(input.env),
				});
		if (!selected.chosen || !selected.opened) return { kind: "missing" };
		const result = await selected.opened.port.access(
			RELAY_RUNTIME_BINDING_ENTRY,
		);
		input.ownerSettings?.assertCurrent?.();
		if (result.status === "denied")
			return {
				kind: result.code === "secret-not-found" ? "missing" : "unavailable",
			};
		if (!result.material || result.material.length > 65_536)
			return { kind: "invalid" };
		const record = parseJsonObject(result.material);
		if (
			Object.keys(record).sort().join(",") !==
				"binding,projectId,schema,teamId" ||
			record.schema !== "hobo.ci-relay-binding/v1" ||
			!isJsonString(record.teamId) ||
			!isJsonString(record.projectId) ||
			!isJsonObject(record.binding)
		)
			return { kind: "invalid" };
		const fields = record.binding;
		if (
			Object.keys(fields).sort().join(",") !==
				"environment,identityId,kind,projectId,secretPath,siteUrl" ||
			fields.kind !== "infisical" ||
			!isJsonString(fields.siteUrl) ||
			!isJsonString(fields.projectId) ||
			!isJsonString(fields.identityId) ||
			!isJsonString(fields.environment) ||
			!isJsonString(fields.secretPath) ||
			!fields.siteUrl ||
			!fields.secretPath
		)
			return { kind: "invalid" };
		let binding: RelayRuntimeBinding;
		try {
			const parsed = parseInfisicalBinding({
				siteUrl: fields.siteUrl,
				projectId: fields.projectId,
				environment: fields.environment,
				secretPath: fields.secretPath,
			});
			if (new URL(parsed.siteUrl).protocol !== "https:")
				return { kind: "invalid" };
			binding = {
				...parsed,
				identityId: parseInfisicalIdentityId(fields.identityId),
			};
		} catch {
			return { kind: "invalid" };
		}
		if (record.teamId !== input.teamId || record.projectId !== input.projectId)
			return { kind: "mismatch" };
		return { kind: "ready", binding };
	} catch {
		return { kind: "unavailable" };
	} finally {
		session.clear();
	}
}
