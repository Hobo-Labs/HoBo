// Test harness: a signing issuer, a bundle builder, a runtime-local
// component host, a fake DNS, a credential store with a known secret, and a
// programmable upstream transport that records every request it receives.
import type { CredentialResolver, OtelMetricPoint, TelemetrySink } from "@hobo/cd";
import type {
	HttpTransport,
	JsonObject,
	ResolveRequest,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import { createInMemoryKms, type JwtSvidClaims, JwtSvidIssuer } from "@hobo/identity";
import type { SignatureVerifier } from "@hobo/registry";
import { createRuntimeLocalComponentHost } from "@hobo/runtime-local";
import {
	type BuiltResolverComponent,
	buildResolverComponent,
	componentizeResolver,
} from "../src/build/index.js";
import {
	type ComponentInvocationRecord,
	type ComponentLogLine,
	type ComponentTimers,
	createDescribeCache,
	createGuestModuleEngine,
	type DescribeCache,
	type LoadedResolverComponent,
	loadResolverComponent,
	type ReconcilerMode,
	type ResolverComponentBundle,
	verifyResolverComponentBundle,
} from "../src/index.js";
import type { ResolverGuestModule } from "../src/guest/types.js";

export const NOW_SECONDS = 1_790_000_000;
export const SECRET = "tok_live_9f8e7d6c5b4a39281706";
export const CREDENTIAL_REF = "vault://acme/upload-token";

export function issuer(): JwtSvidIssuer {
	const kms = createInMemoryKms();
	kms.generateRsaKey("publisher-k1");
	return new JwtSvidIssuer({
		issuerUrl: "https://publisher.registry.test",
		kms,
		activeKeyId: "publisher-k1",
		jwksKeyIds: ["publisher-k1"],
	});
}

export function verifierFor(signer: JwtSvidIssuer): SignatureVerifier {
	return {
		jwks: signer.jwks(),
		issuer: signer.issuerUrl,
		audience: "hobo-registry",
		now: NOW_SECONDS,
	};
}

export async function attest(signer: JwtSvidIssuer, digest: string): Promise<string> {
	const claims: JwtSvidClaims = {
		sub: "spiffe://hobo/component-publisher",
		aud: "hobo-registry",
		tenant: "t1",
		parentPrincipal: { kind: "service", id: "registry" },
		codeVersion: { digest, version: "1.0.0" },
		scope: [],
		exp: NOW_SECONDS + 3600,
		nbf: NOW_SECONDS - 10,
		iat: NOW_SECONDS,
	};
	return signer.signJwtSvid(claims);
}

export function build(manifest: JsonObject, source: string): BuiltResolverComponent {
	const id = typeof manifest.id === "string" ? manifest.id : "component";
	return buildResolverComponent(
		manifest,
		componentizeResolver({ componentId: id, version: "0.0.0", source }),
	);
}

export async function signedBundle(
	built: BuiltResolverComponent,
	signer: JwtSvidIssuer,
): Promise<ResolverComponentBundle> {
	return {
		manifest: built.manifestJson,
		wasm: built.wasm,
		registry: {
			manifest: built.registryManifest,
			attestation: await attest(signer, built.registryDigest),
		},
	};
}

/** A deterministic clock the upstream can advance. */
export class Clock {
	ms = 1_000_000;
	now = (): number => this.ms;
	advance(ms: number): void {
		this.ms += ms;
	}
}

/** Timers that never fire unless the test fires them. */
export class ManualTimers implements ComponentTimers {
	readonly pending: { ms: number; fire: () => void }[] = [];
	set(ms: number, fire: () => void): () => void {
		const entry = { ms, fire };
		this.pending.push(entry);
		return () => {
			const index = this.pending.indexOf(entry);
			if (index >= 0) this.pending.splice(index, 1);
		};
	}
	fireAll(): void {
		for (const entry of this.pending.splice(0)) entry.fire();
	}
}

export type Route = (request: TransportRequest) => TransportResponse | Promise<TransportResponse>;

/** Records requests; routes by `METHOD url-prefix`. */
export class Upstream {
	readonly requests: TransportRequest[] = [];
	readonly routes: [string, Route][] = [];
	route(key: string, handler: Route): this {
		this.routes.push([key, handler]);
		return this;
	}
	transport: HttpTransport = async (request) => {
		this.requests.push(request);
		for (const [key, handler] of this.routes) {
			const [method, prefix] = key.split(" ");
			if ((method === "*" || method === request.method) && request.url.startsWith(prefix ?? ""))
				return handler(request);
		}
		return { status: 404, headers: {}, body: "" };
	};
}

export function respond(status: number, body = "", headers: Record<string, string> = {}): TransportResponse {
	return { status, headers, body };
}

export const publicDns = async (host: string): Promise<readonly string[]> =>
	host.endsWith(".local") ? ["127.0.0.1"] : ["93.184.216.34"];

export class Credentials implements CredentialResolver {
	readonly calls: { ref: string; scope: string }[] = [];
	async resolve(ref: string, scope: string): Promise<Readonly<Record<string, string>>> {
		this.calls.push({ ref, scope });
		if (ref !== CREDENTIAL_REF) throw new Error(`unknown credential ${ref}`);
		return { authorization: `Bearer ${SECRET}` };
	}
}

export class Metrics implements TelemetrySink {
	readonly points: OtelMetricPoint[] = [];
	async spans(): Promise<void> {}
	async metrics(points: readonly OtelMetricPoint[]): Promise<void> {
		this.points.push(...points);
	}
}

export interface HostedOptions {
	readonly mode?: ReconcilerMode;
	readonly now?: () => number;
	readonly timers?: ComponentTimers;
	readonly describeCache?: DescribeCache;
	readonly resolveHost?: (host: string) => Promise<readonly string[]>;
}

export interface Hosted {
	readonly component: LoadedResolverComponent;
	readonly invocations: ComponentInvocationRecord[];
	readonly logs: ComponentLogLine[];
	readonly credentials: Credentials;
	readonly metrics: Metrics;
	readonly built: BuiltResolverComponent;
}

/** Build, sign, verify and load `guest` under `manifest`. */
export async function hosted(
	manifest: JsonObject,
	guest: ResolverGuestModule,
	source: string,
	options: HostedOptions = {},
): Promise<Hosted> {
	const signer = issuer();
	const built = build(manifest, source);
	const verified = await verifyResolverComponentBundle(await signedBundle(built, signer), verifierFor(signer));
	const invocations: ComponentInvocationRecord[] = [];
	const logs: ComponentLogLine[] = [];
	const credentials = new Credentials();
	const metrics = new Metrics();
	const component = await loadResolverComponent(verified, {
		componentHost: createRuntimeLocalComponentHost({ appendEvent: () => undefined }),
		engine: createGuestModuleEngine(new Map([[built.manifest.wasmDigest, guest]])),
		mode: options.mode ?? "conductor",
		resolveHost: options.resolveHost ?? publicDns,
		credentials,
		telemetry: metrics,
		now: options.now ?? (() => 1_000_000),
		timers: options.timers ?? new ManualTimers(),
		describeCache: options.describeCache ?? createDescribeCache(),
		onInvocation: (record) => invocations.push(record),
		onLog: (_id, line) => logs.push(line),
	});
	return { component, invocations, logs, credentials, metrics, built };
}

export function request(productId: string, desired: JsonObject, physicalId?: string): ResolveRequest {
	return {
		ref: {
			slot: "web",
			productId,
			logicalId: "site",
			...(physicalId === undefined ? undefined : { physicalId }),
		},
		desired,
		credentialRef: CREDENTIAL_REF,
	};
}
