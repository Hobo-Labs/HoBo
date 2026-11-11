import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { RuntimeBrokerConfig } from "./relay-runtime-config-schema.js";

// The schema moved to relay-runtime-config-schema.ts, where the config-service
// loader extends it; it is re-exported here for the broker and its tests.
export { RuntimeBrokerConfig };

// Some runtimes represent an empty POST as a stream instead of null. Consume
// only an empty stream, with a fixed deadline and bounded number of chunks.
async function hasEmptyBody(body: ReadableStream<Uint8Array> | null) {
	if (!body) return true;
	const reader = body.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), 1000);
		});
		const consume = async () => {
			for (let chunks = 0; chunks < 32; chunks++) {
				const result = await reader.read();
				if (result.done) return true;
				if (result.value.byteLength !== 0) return false;
			}
			return false;
		};
		return await Promise.race([consume(), timeout]);
	} catch {
		return false;
	} finally {
		if (timer) clearTimeout(timer);
		// Cancellation of an adversarial stream must not delay the response.
		void reader.cancel().catch(() => {});
	}
}

/** The trust configuration is supplied by the broker deployment, not requests. */
export function createNeonSecretBroker(options: {
	teamSlug: string;
	teamId: string;
	projectName: string;
	projectId: string;
	audience: string;
	config: RuntimeBrokerConfig;
	/** Injected only by contract tests; production uses Vercel's pinned JWKS. */
	jwks?: JWTVerifyGetKey;
}) {
	const { teamSlug, teamId, projectName, projectId } = options;
	if (
		!/^[a-z0-9][a-z0-9-]{0,99}$/.test(teamSlug) ||
		!/^team_[A-Za-z0-9]{1,100}$/.test(teamId) ||
		!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(projectName) ||
		!/^prj_[A-Za-z0-9]{1,100}$/.test(projectId)
	)
		throw new Error("invalid Vercel broker identity");
	const config = RuntimeBrokerConfig.parse(options.config);
	const audience = new URL(options.audience);
	if (
		audience.protocol !== "https:" ||
		audience.username ||
		audience.password ||
		audience.search ||
		audience.hash ||
		options.audience !== `${config.HOBO_CI_PUBLIC_URL}/internal/runtime-config`
	)
		throw new Error("invalid broker audience");
	const issuer = `https://oidc.vercel.com/${teamSlug}`;
	const subject = `owner:${teamSlug}:project:${projectName}:environment:production`;
	const jwks =
		options.jwks ??
		createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`), {
			timeoutDuration: 3000,
			cooldownDuration: 30_000,
		});
	return async (request: Request): Promise<Response> => {
		const headers = {
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		};
		if (
			request.method !== "POST" ||
			new URL(request.url).pathname !== "/v1/runtime-config"
		)
			return new Response(null, { status: 404, headers });
		const auth = request.headers.get("authorization") ?? "";
		const match = /^Bearer ([A-Za-z0-9_.-]{1,16384})$/.exec(auth);
		if (!match?.[1]) return new Response(null, { status: 403, headers });
		try {
			const { payload } = await jwtVerify(match[1], jwks, {
				issuer,
				audience: options.audience,
				subject,
				algorithms: ["RS256"],
				requiredClaims: ["iat", "nbf", "exp", "sub"],
				maxTokenAge: "5m",
				clockTolerance: 5,
			});
			if (
				payload.owner !== teamSlug ||
				payload.owner_id !== teamId ||
				payload.project !== projectName ||
				payload.project_id !== projectId ||
				payload.environment !== "production"
			)
				return new Response(null, { status: 403, headers });
			if (!(await hasEmptyBody(request.body)))
				return new Response(null, { status: 404, headers });
			return Response.json({ config }, { status: 200, headers });
		} catch {
			return new Response(null, { status: 403, headers });
		}
	};
}
