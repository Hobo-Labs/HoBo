
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/iu;

export type FrontendPlacement = "remote-public" | "local";

export function classifyConvexBackendUrl(url: string) {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname;
		if (LOOPBACK_HOST.test(host)) {
			return { kind: "loopback", host };
		}
		if (
			/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host) ||
			/^192\.168\.\d{1,3}\.\d{1,3}$/u.test(host) ||
			/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/u.test(host) ||
			/^169\.254\.\d{1,3}\.\d{1,3}$/u.test(host)
		) {
			return { kind: "private", host };
		}
		return { kind: "public", host };
	} catch {
		return { kind: "invalid", host: null };
	}
}

export class ConvexFrontendTopologyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConvexFrontendTopologyError";
	}
}

export function assertConvexBackendReachableFromFrontend(input: {
	readonly frontendPlacement: FrontendPlacement;
	readonly deploymentUrl: string;
	readonly mode: "cloud" | "self-hosted" | "mock";
}): void {
	if (input.frontendPlacement !== "remote-public") return;
	if (input.mode === "mock") return;

	const classified = classifyConvexBackendUrl(input.deploymentUrl);

	if (classified.kind === "loopback" || classified.kind === "private") {
		throw new ConvexFrontendTopologyError(
			`Convex backend ${input.deploymentUrl} is ${classified.kind} — unreachable from a remote frontend. ` +
				"For Cloudflare Examples ship, HoBo provisions self-hosted Convex on Cloudflare Containers " +
				`(official ${"ghcr.io/get-convex/convex-backend"} image) — not laptop docker, not Convex Cloud by default. ` +
				"Local docker compose is only valid when the frontend Yard is local (Webernetes/Lakebed/same-origin).",
		);
	}
	if (classified.kind === "invalid") {
		throw new ConvexFrontendTopologyError(
			`Convex deployment URL is invalid: ${input.deploymentUrl}`,
		);
	}
}
