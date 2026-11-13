/**
 * The authority's configuration file: one JSON object, the protobuf JSON of
 * `FleetAuthorityConfig` (data-models), shared with the operations (src/ops
 * reads `tenant`, `profile`, `dataDir`, `secretPrefix`, `natsUrls` and
 * `natsCredentialsSecret` from the same file), so keys of either are ignored
 * by the other. Parsed once; defaults resolved here.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fromJsonString } from "@bufbuild/protobuf";
import { parseTenantId, type TenantId } from "@hobo/core";
import type { Outcome } from "@hobo/fleet";
import {
	type FleetAuthorityConfig,
	FleetAuthorityConfigSchema,
} from "../_generated/fleet_authority_pb.js";

export type Profile = "standalone" | "high-availability";

// domain-view: FleetAuthorityConfig after parsing, with every default resolved and the tenant branded.
export type AuthorityConfig = Readonly<{
	record: FleetAuthorityConfig;
	issuer: string;
	tenant: TenantId;
	profile: Profile;
	dataDir: string;
	secretPrefix: string;
	natsCredentialsSecret: string;
	natsSentinelCredentialsSecret: string;
	witnessNatsCredentialsSecret: string;
	calloutXkeySecret: string;
	sessionKeySecret: string;
	listenHost: string;
	listenPort: number;
}>;

const DEFAULT_PORT = 8443;

function invalid<T>(message: string): Outcome<T> {
	return { ok: false, error: { code: "invalid-request", message } };
}

export function parseAuthorityConfig(
	text: string,
	baseDir: string,
): Outcome<AuthorityConfig> {
	let record: FleetAuthorityConfig;
	try {
		record = fromJsonString(FleetAuthorityConfigSchema, text, {
			ignoreUnknownFields: true,
		});
	} catch (error) {
		return invalid(
			`the configuration does not parse: ${error instanceof Error ? error.message : "unknown"}`,
		);
	}
	let issuer: URL;
	try {
		issuer = new URL(record.issuer);
	} catch {
		return invalid("issuer is not a URL");
	}
	if (
		issuer.protocol !== "https:" ||
		issuer.pathname !== "/" ||
		issuer.search.length > 0
	)
		return invalid("issuer must be an https origin");
	let tenant: TenantId;
	try {
		tenant = parseTenantId(record.tenant);
	} catch {
		return invalid("tenant is missing or not a tenant id");
	}
	const profileText =
		record.profile.length === 0 ? "standalone" : record.profile;
	if (profileText !== "standalone" && profileText !== "high-availability")
		return invalid(
			`the profile ${profileText} is not standalone or high-availability`,
		);
	if (record.natsUrls.length === 0) return invalid("natsUrls is required");
	const listen =
		record.listen.length === 0 ? `0.0.0.0:${DEFAULT_PORT}` : record.listen;
	const colon = listen.lastIndexOf(":");
	const port = Number(listen.slice(colon + 1));
	if (colon <= 0 || !Number.isSafeInteger(port) || port <= 0 || port > 65_535)
		return invalid("listen must be host:port");
	for (const provider of record.signIn)
		if (
			provider.id !== "oidc" &&
			provider.id !== "github" &&
			provider.id !== "atproto"
		)
			return invalid(
				`sign-in provider ${provider.id} is not oidc, github or atproto`,
			);
	for (const overlay of record.overlay)
		if (overlay.provider !== "tailscale" && overlay.provider !== "netbird")
			return invalid(
				`overlay provider ${overlay.provider} is not tailscale or netbird`,
			);
	const prefix =
		record.secretPrefix.length > 0
			? record.secretPrefix
			: `hobo-fleet/${tenant}`;
	const or = (value: string, fallback: string) =>
		value.length > 0 ? value : fallback;
	return {
		ok: true,
		value: {
			record,
			issuer: issuer.origin,
			tenant,
			profile: profileText,
			dataDir: resolve(baseDir, or(record.dataDir, "data")),
			secretPrefix: prefix,
			natsCredentialsSecret: or(
				record.natsCredentialsSecret,
				`${prefix}/nats-authority`,
			),
			natsSentinelCredentialsSecret: or(
				record.natsSentinelCredentialsSecret,
				`${prefix}/nats-sentinel`,
			),
			witnessNatsCredentialsSecret: or(
				record.witnessNatsCredentialsSecret,
				`${prefix}/nats-witness`,
			),
			calloutXkeySecret: or(record.calloutXkeySecret, `${prefix}/callout-xkey`),
			sessionKeySecret: or(record.sessionKeySecret, `${prefix}/session-key`),
			listenHost: listen.slice(0, colon).replace(/^\[(.*)\]$/u, "$1"),
			listenPort: port,
		},
	};
}

export async function readAuthorityConfig(
	path: string,
): Promise<Outcome<AuthorityConfig>> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return invalid(`cannot read the configuration ${path}`);
	}
	return parseAuthorityConfig(text, dirname(resolve(path)));
}
