import { BrowserWasmProviderError, redactHostText } from "./errors.js";
import {
	type ComponentArtifact,
	createWebCryptoDigest,
	type DigestPort,
	type GuestManifest,
	type HostCapabilities,
	parseGuestManifest,
	parseHostCapabilities,
	parseHostFault,
	verifyComponentArtifact,
} from "./manifest.js";
import { guestManifestPath, HOST_CAPABILITIES_PATH } from "./placement.js";
import {
	createGuardedTransport,
	defaultTransportPolicy,
	type HostAssetTransport,
	type TransportPolicy,
	type TransportResponse,
} from "./transport.js";

export type HostAssetClientOptions = {
	readonly transport: HostAssetTransport;
	readonly origin: string;
	readonly policy?: TransportPolicy;
	readonly digest?: DigestPort;
};

export type FetchedComponent = {
	readonly artifact: ComponentArtifact;
	readonly bytes: Uint8Array;
};

export interface HostAssetClient {
	readonly origin: string;
	fetchHostCapabilities(): Promise<HostCapabilities>;
	fetchGuestManifest(guestId: string): Promise<GuestManifest>;
	fetchComponent(manifest: GuestManifest): Promise<FetchedComponent>;
}

export function errorForHostResponse(
	response: TransportResponse,
	context: { readonly what: string },
): BrowserWasmProviderError {
	let faultCode = "";
	let message = "";
	try {
		const fault = parseHostFault(response.body);
		faultCode = fault.code;
		message = fault.message;
	} catch {
		message = redactHostText(
			new TextDecoder().decode(response.body.slice(0, 256)),
			180,
		);
	}
	const detail = {
		status: response.status,
		what: context.what,
		...(faultCode !== "" ? { faultCode } : undefined),
		...(message !== "" ? { message } : undefined),
	};

	if (response.status === 404 || faultCode === "GUEST_NOT_FOUND") {
		return new BrowserWasmProviderError(
			"BUNDLE_UNAVAILABLE",
			`the host origin has no ${context.what}`,
			{ detail },
		);
	}
	if (faultCode === "HOST_UNSUPPORTED") {
		return new BrowserWasmProviderError(
			"HOST_UNSUPPORTED",
			`the host origin cannot serve ${context.what}`,
			{ detail },
		);
	}
	if (response.status >= 500) {
		return new BrowserWasmProviderError(
			"BUNDLE_UNAVAILABLE",
			`the host origin returned ${response.status} for ${context.what}`,
			{ retryable: true, detail },
		);
	}
	return new BrowserWasmProviderError(
		"PROVIDER_CONTRACT_CHANGED",
		`the host origin returned an unexpected ${response.status} for ${context.what}`,
		{ detail },
	);
}

export function createHostAssetClient(
	options: HostAssetClientOptions,
): HostAssetClient {
	const policy = options.policy ?? defaultTransportPolicy(options.origin);
	const transport = createGuardedTransport(options.transport, policy);
	const digest = options.digest ?? createWebCryptoDigest();
	const base = options.origin.replace(/\/+$/u, "");

	async function get(path: string, accept: string): Promise<TransportResponse> {
		return transport.request({
			method: "GET",
			url: `${base}${path}`,
			headers: { Accept: accept },
			timeoutMs: policy.timeoutMs,
			maxResponseBytes: policy.maxResponseBytes,
		});
	}

	return {
		origin: options.origin,

		async fetchHostCapabilities() {
			const response = await get(HOST_CAPABILITIES_PATH, "application/json");
			if (response.status !== 200) {
				throw errorForHostResponse(response, { what: "host capabilities" });
			}
			return parseHostCapabilities(response.body);
		},

		async fetchGuestManifest(guestId) {
			const response = await get(
				guestManifestPath(guestId),
				"application/json",
			);
			if (response.status !== 200) {
				throw errorForHostResponse(response, {
					what: `a manifest for ${guestId}`,
				});
			}
			return parseGuestManifest(response.body, { guestId });
		},

		async fetchComponent(manifest) {
			const response = await get(manifest.componentPath, "application/wasm");
			if (response.status !== 200) {
				throw errorForHostResponse(response, {
					what: `a bundle for ${manifest.guestId}`,
				});
			}
			const artifact = await verifyComponentArtifact({
				bytes: response.body,
				headers: response.headers,
				manifest,
				digest,
			});
			return { artifact, bytes: response.body };
		},
	};
}
