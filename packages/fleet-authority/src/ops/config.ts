// The operations' settings, read from the file `OpsContext.configPath` names.
// Unknown keys are ignored, so the authority's own configuration file (its
// `FleetAuthorityConfig` keys plus these) serves both. Private to L27.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseTenantId, type TenantId } from "@hobo/core";
import type { Outcome } from "@hobo/fleet";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	numberField,
	parseJson,
	stringField,
} from "./json.js";

export type Profile = "standalone" | "high-availability";

// domain-view: the operations' deployment settings; `FleetAuthorityConfig` (data-models, L09) does not yet carry the tenant, store or secret names.
export type OpsConfig = Readonly<{
	tenant: TenantId;
	profile: Profile;
	/** Every key's secret is `<secretPrefix>/<which>`. */
	secretPrefix: string;
	operatorName: string;
	/** Standalone: the directory holding the SQLite journal `fleet.db`. */
	dataDir: string;
	natsUrls: readonly string[];
	/** The secret holding the authority's static-user NATS credentials. */
	natsCredentialsSecret: string;
	/** How long a trust-record change waits for the witness's co-signature. */
	witnessTimeoutMs: number;
}>;

const DEFAULT_WITNESS_TIMEOUT_MS = 120_000;

function invalid<T>(message: string): Outcome<T> {
	return { ok: false, error: { code: "invalid-request", message } };
}

export function parseOpsConfig(
	text: string,
	baseDir: string,
): Outcome<OpsConfig> {
	const value = parseJson(text);
	if (!isJsonObject(value))
		return invalid("the configuration is not a JSON object");
	const tenantText = stringField(value, "tenant");
	if (tenantText === undefined)
		return invalid("the configuration names no tenant");
	let tenant: TenantId;
	try {
		tenant = parseTenantId(tenantText);
	} catch {
		return invalid(`the tenant ${tenantText} is not a tenant id`);
	}
	const profileText = stringField(value, "profile") ?? "standalone";
	const profile: Profile | undefined =
		profileText === "standalone" || profileText === "high-availability"
			? profileText
			: undefined;
	if (profile === undefined)
		return invalid(
			`the profile ${profileText} is not standalone or high-availability`,
		);
	const urls = value.natsUrls;
	const natsUrls: string[] = [];
	if (urls !== undefined) {
		if (!isJsonArray(urls)) return invalid("natsUrls is not a list");
		for (const url of urls) {
			if (!isJsonString(url)) return invalid("natsUrls holds a non-string");
			natsUrls.push(url);
		}
	}
	if (profile === "high-availability" && natsUrls.length === 0)
		return invalid("the high-availability profile needs natsUrls");
	const secretPrefix =
		stringField(value, "secretPrefix") ?? `hobo-fleet/${tenant}`;
	const witnessTimeoutMs =
		numberField(value, "witnessTimeoutMs") ?? DEFAULT_WITNESS_TIMEOUT_MS;
	if (!(witnessTimeoutMs > 0))
		return invalid("witnessTimeoutMs must be positive");
	return {
		ok: true,
		value: {
			tenant,
			profile,
			secretPrefix,
			operatorName: stringField(value, "operatorName") ?? "hobo-fleet",
			dataDir: resolve(baseDir, stringField(value, "dataDir") ?? "data"),
			natsUrls,
			natsCredentialsSecret:
				stringField(value, "natsCredentialsSecret") ??
				`${secretPrefix}/nats-authority`,
			witnessTimeoutMs,
		},
	};
}

export async function readOpsConfig(
	configPath: string,
): Promise<Outcome<OpsConfig>> {
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch {
		return invalid(`cannot read the configuration ${configPath}`);
	}
	return parseOpsConfig(text, dirname(resolve(configPath)));
}
