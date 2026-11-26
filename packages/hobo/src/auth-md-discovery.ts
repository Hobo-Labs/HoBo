import {
	type AuthMdDiscovery,
	discoverAuthMd,
	type HttpPort,
	isAuthMdError,
	parseHttpsUrl,
	protectedResourceMetadataUrl,
	requestJson,
} from "@hobo/auth-md";
import { parseBrokerDiscoveryDocument } from "./broker-discovery.js";
import { cloneAsJson, isJsonObject } from "./json.js";

function absent(error: Error, url: string): boolean {
	return (
		isAuthMdError(error) &&
		error.code === "AUTHMD_DISCOVERY_FAILED" &&
		error.details.url === url &&
		["404", "410"].includes(error.details.status ?? "")
	);
}

/** Standard metadata stays authoritative; only absence permits a broker's explicit alternative. */
export async function discoverAuthMdForLifecycle(input: {
	readonly port: HttpPort;
	readonly resource: string;
	readonly metadataUrl?: string;
	readonly expectedResource?: string;
}): Promise<AuthMdDiscovery> {
	const selected = parseHttpsUrl(input.resource);
	let discovery: AuthMdDiscovery;
	try {
		discovery = await discoverAuthMd(input);
	} catch (error) {
		if (
			input.metadataUrl !== undefined ||
			!(error instanceof Error) ||
			!absent(error, protectedResourceMetadataUrl(selected))
		)
			throw error;
		const base = selected.replace(/\/+$/u, "");
		let advertised: string | undefined;
		for (const path of ["/.well-known/hobo-broker", "/discovery"]) {
			const url = `${base}${path}`;
			let raw: ReturnType<typeof cloneAsJson>;
			try {
				raw = cloneAsJson(
					await requestJson(input.port, url, { rejectRedirects: true }),
				);
			} catch (cause) {
				if (cause instanceof Error && absent(cause, url)) continue;
				throw cause;
			}
			const candidate =
				isJsonObject(raw) && isJsonObject(raw.hobo_broker)
					? raw.hobo_broker
					: raw;
			const broker = parseBrokerDiscoveryDocument(candidate);
			if (!broker.resourceMetadataUrl)
				throw new Error(
					"The broker did not advertise auth.md protected-resource metadata",
				);
			advertised = parseHttpsUrl(broker.resourceMetadataUrl);
			break;
		}
		if (!advertised) throw error;
		discovery = await discoverAuthMd({
			port: input.port,
			resource: selected,
			metadataUrl: advertised,
		});
	}
	if (
		input.expectedResource !== undefined &&
		discovery.metadata.resource !== parseHttpsUrl(input.expectedResource)
	)
		throw new Error(
			"auth.md metadata changed the registered protected resource",
		);
	return discovery;
}
