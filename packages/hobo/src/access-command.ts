/**
 * `hobo access` — elevated / cross-env access requests (observe + request).
 * Produces auditable, expiring grants/capabilities — not raw ACL JSON.
 *
 * Subcommands: request | break-glass | status
 * Mutations that grant production access require dual control in the control plane.
 */

import type { CommandModule } from "@hobo/cli";
import {
	BreakGlassService,
	CrossEnvGrantStore,
	type ElevatedCapabilityIssuer,
	EnvMembershipService,
	type IsolationClass,
	mintElevatedAccessCapability,
	parseIsolationClass,
} from "@hobo/connectivity";
import {
	createLocalSvidIssuer,
	LOCAL_SVID_ISSUER,
} from "./credential-presenter.js";
import { isJsonString, type JsonObject, type JsonValue } from "./json.js";

export interface AccessCommandDeps {
	readonly env?: NodeJS.ProcessEnv;
	readonly membership?: EnvMembershipService;
	readonly crossEnv?: CrossEnvGrantStore;
	readonly breakGlass?: BreakGlassService;
	/**
	 * Mints elevated capabilities: `@hobo/identity`'s `JwtSvidIssuer` (ADR-0183,
	 * no shared secret). Defaults to an in-memory RS256 issuer for offline
	 * development, named by HOBO_SVID_ISSUER.
	 */
	readonly elevatedIssuer?: ElevatedCapabilityIssuer;
	readonly now?: () => string;
}

const SUBCOMMANDS = ["request", "break-glass", "status"] as const;

function parseDurationSeconds(
	raw: JsonValue | undefined,
	fallback: number,
): number {
	if (!isJsonString(raw) || raw.length === 0) return fallback;
	const m = raw.match(/^(\d+)(s|m|h)?$/);
	if (!m) return fallback;
	const n = Number(m[1]);
	const unit = m[2] ?? "m";
	if (unit === "s") return n;
	if (unit === "h") return n * 3600;
	return n * 60;
}

export function createAccessCommand(
	deps: AccessCommandDeps = {},
): CommandModule {
	return {
		run: async ({ args, flags, emitProgress }) => {
			const env = deps.env ?? process.env;
			// SAFETY: assertion required at this I/O or test boundary.
			const f = flags as JsonObject;
			const tenant =
				(isJsonString(f.tenant) && f.tenant) || env.HOBO_TENANT || "local";
			const now = deps.now ?? (() => new Date().toISOString());
			const membership =
				deps.membership ?? new EnvMembershipService({ tenant, now });
			const crossEnv = deps.crossEnv ?? new CrossEnvGrantStore({ tenant, now });
			const breakGlass =
				deps.breakGlass ?? new BreakGlassService({ tenant, now });
			const elevatedIssuer = (): ElevatedCapabilityIssuer =>
				deps.elevatedIssuer ??
				createLocalSvidIssuer(env.HOBO_SVID_ISSUER ?? LOCAL_SVID_ISSUER);

			// SAFETY: assertion required at this I/O or test boundary.
			const sub = (args[0] ?? "status") as string;
			// SAFETY: assertion required at this I/O or test boundary.
			if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_ACCESS_USAGE",
					message: `hobo access: unknown subcommand "${sub}"`,
					remediation: [
						"hobo access request --env production --reason '...'",
						"hobo access break-glass --env production --reason '...'",
						"hobo access status",
					],
					data: { command: "access", subcommands: [...SUBCOMMANDS] },
				};
			}

			if (sub === "status") {
				emitProgress("access status: membership + grants (control-plane)");
				return {
					ok: true,
					status: "ok",
					code: "HOBO_ACCESS_STATUS",
					message: "access status",
					data: {
						command: "access",
						subcommand: "status",
						memberships: membership.list(),
						policyPack: "hobo.env-network-isolation/v1",
						networkMembershipSufficientAlone: false,
					},
				};
			}

			const targetEnvRaw =
				(isJsonString(f.env) && f.env) ||
				(isJsonString(f.environment) && f.environment) ||
				args[1];
			const targetClass = parseIsolationClass(
				isJsonString(targetEnvRaw) ? targetEnvRaw : null,
			);
			if (!targetClass) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_ACCESS_ENV_REQUIRED",
					message: "hobo access requires --env <isolation-class>",
					remediation: [
						"Use --env production|staging|development|preview|ephemeral|local-dev",
					],
					data: { command: "access", subcommand: sub },
				};
			}

			const reason =
				(isJsonString(f.reason) && f.reason) || "operator access request";
			const subject =
				(isJsonString(f.subject) && f.subject) ||
				env.HOBO_SUBJECT ||
				"user:local";
			const duration = parseDurationSeconds(f.duration, 1800);
			const actor =
				(isJsonString(f.actor) && f.actor) || "control-plane:operator";

			if (sub === "break-glass") {
				const requested = breakGlass.request({
					subject,
					isolationClass: targetClass,
					reason,
					requester: actor,
				});
				// Dual approval: operator can pass --approver for the second party.
				const approver = isJsonString(f.approver) ? f.approver : undefined;
				if (approver) {
					const granted = breakGlass.approve({
						grantId: requested.id,
						approver,
						ttlSeconds: duration,
					});
					const minted = await mintElevatedAccessCapability({
						subject,
						isolationClass: targetClass,
						issuedBy: approver,
						ttlSeconds: duration,
						evidence: { kind: "break-glass", ref: granted.id },
						priorAuthnClass: "development",
						issuer: elevatedIssuer(),
						now: now(),
					});
					emitProgress(
						`break-glass granted ${granted.id} exp ${granted.expiresAt}`,
					);
					return {
						ok: true,
						status: "granted",
						code: "HOBO_BREAK_GLASS_GRANTED",
						message: `break-glass granted for ${targetClass}`,
						data: {
							command: "access",
							subcommand: "break-glass",
							grant: granted,
							capabilityId: minted.capability.id,
							tokenRef: minted.capability.tokenRef,
							// token available for operator session bootstrap; not logged
							elevatedToken: minted.token,
							expiresAt: minted.capability.expiresAt,
						},
					};
				}
				emitProgress(
					`break-glass requested ${requested.id} (awaiting dual approval)`,
				);
				return {
					ok: true,
					status: "requested",
					code: "HOBO_BREAK_GLASS_REQUESTED",
					message:
						"break-glass requested — provide --approver (distinct from requester) to grant",
					data: {
						command: "access",
						subcommand: "break-glass",
						grant: requested,
					},
				};
			}

			// request — elevated capability after lower-env evidence
			const fromClass: IsolationClass =
				parseIsolationClass(isJsonString(f.from) ? f.from : "development") ??
				"development";

			// Ensure membership in prior class (control-plane) for the subject.
			if (!membership.getActive(subject, fromClass, now())) {
				membership.assign({
					principalId: subject,
					isolationClass: fromClass,
					assignedBy: actor,
					...(targetClass === "production"
						? { secondApprover: "role:security-officer" }
						: undefined),
					// production assign of membership for fromClass isn't production class
				});
			}

			const grant = crossEnv.issue({
				fromClass,
				toClass: targetClass,
				principalIds: [subject],
				reason,
				issuedBy: actor,
				ttlSeconds: duration,
				...(targetClass === "production"
					? { dualControlApprovers: ["role:security-officer"] }
					: undefined),
			});

			const minted = await mintElevatedAccessCapability({
				subject,
				isolationClass: targetClass,
				issuedBy: actor,
				ttlSeconds: duration,
				priorAuthnClass: fromClass,
				evidence: {
					kind: "lower-env-authn",
					ref: grant.id,
				},
				issuer: elevatedIssuer(),
				now: now(),
			});

			emitProgress(
				`access granted ${targetClass} via capability ${minted.capability.id} (exp ${minted.capability.expiresAt})`,
			);
			return {
				ok: true,
				status: "granted",
				code: "HOBO_ACCESS_GRANTED",
				message: `elevated access capability minted for ${targetClass}`,
				data: {
					command: "access",
					subcommand: "request",
					crossEnvGrantId: grant.id,
					capabilityId: minted.capability.id,
					tokenRef: minted.capability.tokenRef,
					elevatedToken: minted.token,
					isolationClass: targetClass,
					expiresAt: minted.capability.expiresAt,
					networkMembershipSufficientAlone: false,
					obligations: minted.capability.obligations,
				},
			};
		},
	};
}
