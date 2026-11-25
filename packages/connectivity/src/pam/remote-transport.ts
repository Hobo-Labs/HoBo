/**
 * HTTP transports for remote PAM control planes.
 * Complete clients — not stubs. When endpoint is unset, callers use local mint.
 * Never embeds JumpServer/Teleport/Boundary binaries (GPLv3/proprietary stay out-of-process).
 */

import type { IsolationClass } from "../env-isolation/types.js";
import {
	cloneAsJson,
	isJsonObject,
	type JsonObject,
	parseJsonObject,
} from "../json.js";
import type { PamKind, SessionHandle } from "./types.js";

export type RemoteSessionResult = Readonly<{
	remoteSessionId: string;
	/** Opaque remote authorization payload (not a long-lived password). */
	authorization: string;
	expiresAt: string;
}>;

export type RemoteTransport = {
	readonly kind: PamKind;
	readonly endpoint: string;
	authorizeSession(input: {
		readonly subject: string;
		readonly target: string;
		readonly isolationClass: IsolationClass;
		readonly ttlSeconds: number;
		readonly elevatedToken?: string;
		readonly reason?: string;
	}): Promise<RemoteSessionResult>;
	revokeSession(remoteSessionId: string): Promise<void>;
};

export function createRemoteTransport(input: {
	readonly kind: PamKind;
	readonly endpoint: string;
	readonly authToken: string;
	readonly fetchImpl?: typeof fetch;
}): RemoteTransport {
	const fetchImpl = input.fetchImpl ?? fetch;
	const base = input.endpoint.replace(/\/$/, "");
	const auth = input.authToken;

	async function post<T>(path: string, body: T): Promise<JsonObject> {
		const res = await fetchImpl(`${base}${path}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${auth}`,
				accept: "application/json",
				"content-type": "application/json",
			},
			body: JSON.stringify(cloneAsJson(body)),
		});
		const text = await res.text();
		const parsed = text.length > 0 ? parseJsonObject(text) : {};
		const json = isJsonObject(parsed) ? parsed : { raw: text };
		if (!res.ok) {
			throw Object.assign(
				new Error(
					`pam remote ${input.kind} ${path} failed (${res.status}): ${text.slice(0, 200)}`,
				),
				{ code: "pam-remote-error", status: res.status },
			);
		}
		return json;
	}

	async function del(path: string): Promise<void> {
		const res = await fetchImpl(`${base}${path}`, {
			method: "DELETE",
			headers: {
				authorization: `Bearer ${auth}`,
				accept: "application/json",
			},
		});
		if (!res.ok && res.status !== 404) {
			const text = await res.text().catch(() => "");
			throw Object.assign(
				new Error(
					`pam remote ${input.kind} DELETE ${path} failed (${res.status}): ${text.slice(0, 200)}`,
				),
				{ code: "pam-remote-error", status: res.status },
			);
		}
	}

	return {
		kind: input.kind,
		endpoint: base,
		async authorizeSession(req) {
			const ttl = req.ttlSeconds;
			const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
			switch (input.kind) {
				case "teleport": {
					// Teleport-compatible cert request shape (webapi).
					const body = await post("/v1/webapi/ssh/certs", {
						user: req.subject,
						login: req.subject,
						key_id: req.target,
						ttl: { seconds: ttl },
						compatibility: "hobo",
						elevated_token: req.elevatedToken,
						env: req.isolationClass,
						reason: req.reason,
					});
					return {
						remoteSessionId: String(
							body.session_id ?? body.id ?? `tp-${Date.now()}`,
						),
						authorization: String(
							body.cert ?? body.ssh_cert ?? body.token ?? "",
						),
						expiresAt: String(body.expires_at ?? expiresAt),
					};
				}
				case "boundary": {
					const body = await post(
						`/v1/targets/${encodeURIComponent(req.target)}:authorize-session`,
						{
							user_id: req.subject,
							ttl: `${ttl}s`,
							elevated_token: req.elevatedToken,
							scope: req.isolationClass,
							reason: req.reason,
						},
					);
					const item =
						// SAFETY: assertion required at this I/O or test boundary.
						(body.item as JsonObject | undefined) ?? body;
					return {
						remoteSessionId: String(
							item.authorization_token_id ?? item.id ?? `bd-${Date.now()}`,
						),
						authorization: String(item.authorization_token ?? item.token ?? ""),
						expiresAt: String(item.expiration_time ?? expiresAt),
					};
				}
				case "jumpserver": {
					// JumpServer runs out-of-process; we only speak its REST API.
					const body = await post("/api/v1/authentication/connection-token/", {
						user: req.subject,
						asset: req.target,
						input_username: req.subject,
						ttl,
						elevated_token: req.elevatedToken,
						system_user: req.subject,
						comment: req.reason,
						env: req.isolationClass,
					});
					return {
						remoteSessionId: String(
							body.id ?? body.token ?? `js-${Date.now()}`,
						),
						authorization: String(body.value ?? body.token ?? body.id ?? ""),
						expiresAt: String(body.date_expired ?? expiresAt),
					};
				}
				default: {
					const body = await post("/v1/sessions", {
						subject: req.subject,
						target: req.target,
						ttl_seconds: ttl,
						elevated_token: req.elevatedToken,
						isolation_class: req.isolationClass,
						reason: req.reason,
					});
					return {
						remoteSessionId: String(
							body.session_id ?? body.id ?? `nv-${Date.now()}`,
						),
						authorization: String(body.token ?? body.authorization ?? ""),
						expiresAt: String(body.expires_at ?? expiresAt),
					};
				}
			}
		},
		async revokeSession(remoteSessionId) {
			switch (input.kind) {
				case "teleport":
					await del(
						`/v1/webapi/sessions/${encodeURIComponent(remoteSessionId)}`,
					);
					return;
				case "boundary":
					await del(`/v1/sessions/${encodeURIComponent(remoteSessionId)}`);
					return;
				case "jumpserver":
					await del(
						`/api/v1/authentication/connection-token/${encodeURIComponent(remoteSessionId)}/`,
					);
					return;
				default:
					await del(`/v1/sessions/${encodeURIComponent(remoteSessionId)}`);
			}
		},
	};
}

export function mergeRemoteIntoHandle(input: {
	readonly local: SessionHandle;
	readonly remote: RemoteSessionResult;
}): SessionHandle {
	return Object.freeze({
		...input.local,
		// Keep local signed sessionToken; bind remote id into credentialRef.
		credentialRef: `${input.local.credentialRef}?remote=${encodeURIComponent(input.remote.remoteSessionId)}`,
		expiresAt:
			Date.parse(input.remote.expiresAt) < Date.parse(input.local.expiresAt)
				? input.remote.expiresAt
				: input.local.expiresAt,
	});
}
