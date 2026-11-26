import { z } from "zod";
import {
	AppRegistrationUncertainError,
	type createAppRegistration,
} from "./app-registration.js";
import type { OnboardingGithubPort } from "./onboarding.js";

const Actor = z.object({
	accountId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
	subject: z.string().min(1).max(200),
});
type Actor = z.infer<typeof Actor>;
const User = z.object({
	id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const Installation = z.object({
	account: z.object({
		id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		login: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
		type: z.enum(["User", "Organization"]),
	}),
});
const Membership = z.object({
	role: z.literal("admin"),
	state: z.literal("active"),
});
const RequestBody = z
	.object({ purpose: z.enum(["register", "install"]) })
	.strict();

/** Tokens must be resolved server-side for the already-authenticated subject. */
export function createGithubInstallationAdminVerifier(options: {
	github: OnboardingGithubPort;
	getUserToken: (actor: Actor) => Promise<string | undefined>;
	fetch?: typeof fetch;
}) {
	const send = options.fetch ?? fetch;
	return async (input: Actor, installationId: number): Promise<boolean> => {
		const actor = Actor.parse(input);
		if (!Number.isSafeInteger(installationId) || installationId <= 0)
			return false;
		try {
			const token = await options.getUserToken(actor);
			if (!token) return false;
			const appResult = await options.github.appRequest(
				`/app/installations/${installationId}`,
			);
			if (!appResult.ok) return false;
			const installation = Installation.parse(await appResult.json());
			const headers = {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2026-03-10",
			};
			const userResult = await send("https://api.github.com/user", {
				headers,
				redirect: "error",
				signal: AbortSignal.timeout(15000),
			});
			if (!userResult.ok) return false;
			const user = User.parse(await userResult.json());
			if (installation.account.type === "User")
				return user.id === installation.account.id;
			const membership = await send(
				`https://api.github.com/user/memberships/orgs/${encodeURIComponent(installation.account.login)}`,
				{ headers, redirect: "error", signal: AbortSignal.timeout(15000) },
			);
			return (
				membership.ok && Membership.safeParse(await membership.json()).success
			);
		} catch {
			return false;
		}
	};
}

/** Authenticate is a trusted session verifier; NEVER construct its actor from request JSON. */
export function createAppRegistrationHandler(options: {
	registration: ReturnType<typeof createAppRegistration>;
	authenticate: (request: Request) => Promise<Actor | undefined>;
	installationUrl?: (state: string) => Promise<string>;
}) {
	function respond(
		status: number,
		value:
			| { error: string }
			| { state: string; installationUrl?: string }
			| { appId: number }
			| { installationId: number },
	) {
		return Response.json(value, {
			status,
			headers: { "cache-control": "no-store" },
		});
	}
	return async (request: Request): Promise<Response | undefined> => {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/v1/app-registration/")) return undefined;
		try {
			const actor = await options.authenticate(request);
			if (!actor) return respond(401, { error: "authentication required" });
			if (
				url.pathname === "/v1/app-registration/state" &&
				request.method === "POST"
			) {
				const origin = request.headers.get("origin");
				if (origin && origin !== url.origin)
					return respond(403, { error: "origin rejected" });
				if (
					request.headers.get("content-type")?.split(";")[0] !==
					"application/json"
				)
					return respond(415, { error: "JSON required" });
				const reader = request.body?.getReader();
				const chunks: Uint8Array[] = [];
				let bytes = 0;
				if (reader) {
					for (;;) {
						const result = await reader.read();
						if (result.done) break;
						bytes += result.value.byteLength;
						if (bytes > 4096) {
							await reader.cancel();
							return respond(413, { error: "request too large" });
						}
						chunks.push(result.value);
					}
				}
				const input = RequestBody.parse(
					JSON.parse(Buffer.concat(chunks).toString("utf8")),
				);
				const state = await options.registration.begin(actor, input.purpose);
				const installationUrl =
					input.purpose === "install" && options.installationUrl
						? await options.installationUrl(state)
						: undefined;
				if (installationUrl) return respond(200, { state, installationUrl });
				return respond(200, { state });
			}
			if (
				url.pathname === "/v1/app-registration/manifest-callback" &&
				request.method === "GET"
			) {
				if (
					url.searchParams.getAll("state").length !== 1 ||
					url.searchParams.getAll("code").length !== 1
				)
					return respond(400, { error: "invalid registration callback" });
				const state = url.searchParams.get("state") ?? "";
				const code = url.searchParams.get("code") ?? "";
				return respond(
					200,
					await options.registration.completeRegistration(actor, state, code),
				);
			}
			if (
				url.pathname === "/v1/app-registration/install-callback" &&
				request.method === "GET"
			) {
				const action = url.searchParams.get("setup_action");
				const rawId = url.searchParams.get("installation_id") ?? "";
				if (
					url.searchParams.getAll("state").length !== 1 ||
					url.searchParams.getAll("installation_id").length !== 1 ||
					url.searchParams.getAll("setup_action").length !== 1 ||
					(action !== "install" && action !== "update") ||
					!/^[1-9]\d{0,15}$/.test(rawId)
				)
					return respond(400, { error: "invalid installation callback" });
				const installed = await options.registration.completeInstallation(
					actor,
					url.searchParams.get("state") ?? "",
					Number(rawId),
				);
				if (request.headers.get("accept")?.includes("text/html"))
					return new Response(null, {
						status: 303,
						headers: {
							location: "/v1/app-registration/setup?status=installed",
							"cache-control": "no-store",
							"referrer-policy": "no-referrer",
						},
					});
				return respond(200, installed);
			}
			return respond(404, { error: "not found" });
		} catch (error) {
			if (error instanceof AppRegistrationUncertainError)
				return respond(409, {
					error: "App conversion uncertain; operator reconciliation required",
				});
			if (error instanceof z.ZodError || error instanceof SyntaxError)
				return respond(400, { error: "invalid request" });
			if (
				error instanceof Error &&
				/^(not authorized|invalid or expired state|GitHub administrator authority required|installation belongs to another App|installation already bound)/.test(
					error.message,
				)
			)
				return respond(403, { error: "registration not authorized" });
			return respond(503, { error: "registration unavailable" });
		}
	};
}
