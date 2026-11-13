import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

import {
	createUsageEvent,
	type FunnelPublishOptions,
	type FunnelPublishResult,
	type MagicDnsSplitConfig,
	type MagicDnsSplitResult,
	type MeteringBus,
	type OverlayIdentity,
	type OverlayJoinOptions,
	type OverlayJoinResult,
	type OverlayNetwork,
	type PolicyEngine,
	parseTenantId,
	type TenantId,
} from "@hobo/core";

/**
 * Runs `use` with `secret` in a file only this user can read, in a fresh
 * private directory that is removed afterwards, whatever `use` does.
 */
function withSecretFile<T>(secret: string, use: (path: string) => T): T {
	const dir = mkdtempSync(joinPath(tmpdir(), "hobo-overlay-"));
	try {
		const path = joinPath(dir, "auth-key");
		writeFileSync(path, secret, { mode: 0o600, flag: "wx" });
		return use(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export type TailscaleRunner = (
	args: readonly string[],
	env?: NodeJS.ProcessEnv,
) => { ok: boolean; stdout: string; stderr: string };

/**
 * Tailscale overlay adapter with MagicDNS split DNS and Funnel gateway automation.
 * Uses the official `tailscale` CLI when present; otherwise degrades offline-friendly.
 */
export function createTailscaleOverlay(options?: {
	readonly metering?: MeteringBus;
	readonly policy?: PolicyEngine;
	readonly bin?: string;
	readonly run?: TailscaleRunner;
	/** Default MagicDNS domains for hierarchical overlay names. */
	readonly defaultMagicDnsDomains?: readonly string[];
	/**
	 * Tailscale API key for control-plane MagicDNS split DNS.
	 * Also read from env TS_API_KEY / HOBO_TS_API_KEY when unset.
	 */
	readonly apiKey?: string;
	readonly tailnet?: string;
	readonly apiBase?: string;
	readonly fetchImpl?: typeof fetch;
}): OverlayNetwork {
	const bin = options?.bin ?? "tailscale";
	const run: TailscaleRunner =
		options?.run ??
		((args, env) => {
			const result = spawnSync(bin, [...args], {
				encoding: "utf8",
				env: { ...process.env, ...env },
			});
			return {
				ok: result.status === 0,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
			};
		});

	let current: OverlayIdentity | null = null;

	return {
		provider: "tailscale",
		tenantTags({ tenantId, role, env, cloud, overlayNetworkId }) {
			const tags = [
				`tenant:${tenantId}`,
				`role:${role}`,
				`tag:${role === "laptop" ? "dev-laptop" : role}`,
			];
			if (env) tags.push(`env:${env}`);
			if (cloud) tags.push(`cloud:${cloud}`);
			if (overlayNetworkId) tags.push(`overlay:${overlayNetworkId}`);
			return tags;
		},
		async join(join: OverlayJoinOptions): Promise<OverlayJoinResult> {
			const tags = [...join.tags];
			if (!tags.some((t) => t.startsWith("tenant:"))) {
				tags.push(`tenant:${join.tenantId}`);
			}

			if (options?.policy) {
				const decision = await options.policy.evaluate({
					subject: {
						identity: join.hostname,
						tenantId: join.tenantId,
						tags,
					},
					action: "overlay.join",
					resource: {
						kind: "overlay",
						id: "tailscale",
						tenantId: join.tenantId,
						tags,
					},
				});
				if (decision.effect === "deny") {
					return {
						identity: {
							nodeId: "denied",
							hostname: join.hostname,
							overlayIps: [],
							tags,
							tenantId: join.tenantId,
						},
						provider: "tailscale",
						ready: false,
						notes: decision.reasons,
					};
				}
			}

			const notes: string[] = [];
			const statusProbe = run(["status", "--json"]);
			if (!statusProbe.ok) {
				notes.push(
					"tailscale CLI not available or not logged in; overlay join degraded (install tailscale and authenticate for full cross-cloud)",
				);
				current = {
					nodeId: `stub:${join.hostname}`,
					hostname: join.hostname,
					overlayIps: [],
					tags,
					tenantId: join.tenantId,
				};
				await options?.metering?.emit(
					createUsageEvent({
						tenantId: join.tenantId,
						eventType: "overlay.join",
						resource: join.hostname,
						metadata: { provider: "tailscale", ready: false },
					}),
				);
				join.emitProgress?.(
					"hobo overlay: tailscale unavailable — continuing in degraded mode",
				);
				return {
					identity: current,
					provider: "tailscale",
					ready: false,
					notes,
				};
			}

			if (join.authKey) {
				// Never on argv: tailscale reads the credential from a private file.
				const up = withSecretFile(join.authKey, (path) =>
					run([
						"up",
						`--auth-key=file:${path}`,
						"--hostname",
						join.hostname,
						"--advertise-tags",
						tags.join(","),
						"--accept-dns=true",
					]),
				);
				if (!up.ok) {
					notes.push(
						`tailscale up failed: ${up.stderr.trim() || up.stdout.trim()}`,
					);
				}
			} else {
				notes.push(
					"no authKey provided; assuming existing tailscale session (enroll this device to receive an OverlayJoin from the fleet authority)",
				);
			}

			// Ensure MagicDNS acceptance for hierarchical resolution.
			const setDns = run(["set", "--accept-dns=true"]);
			if (!setDns.ok) {
				notes.push(
					`tailscale set --accept-dns failed: ${setDns.stderr.trim() || "unknown"}`,
				);
			}

			let nodeId = join.hostname;
			let overlayIps: string[] = [];
			let dnsName: string | undefined;
			try {
				// SAFETY: assertion required at this I/O or test boundary.
				const parsed = JSON.parse(statusProbe.stdout) as {
					Self?: {
						ID?: string;
						DNSName?: string;
						TailscaleIPs?: string[];
					};
				};
				nodeId = parsed.Self?.ID ?? nodeId;
				overlayIps = parsed.Self?.TailscaleIPs ?? [];
				dnsName = parsed.Self?.DNSName?.replace(/\.$/, "");
			} catch {
				notes.push("could not parse tailscale status --json");
			}

			current = {
				nodeId,
				hostname: join.hostname,
				overlayIps,
				tags,
				tenantId: join.tenantId,
			};
			await options?.metering?.emit(
				createUsageEvent({
					tenantId: join.tenantId,
					eventType: "overlay.join",
					resource: join.hostname,
					metadata: {
						provider: "tailscale",
						ready: true,
						ips: overlayIps.join(","),
						...(dnsName !== undefined ? { dnsName } : undefined),
					},
				}),
			);
			join.emitProgress?.(
				`hobo overlay: joined tailscale as ${join.hostname} tags=[${tags.join(",")}]` +
					(dnsName ? ` magicdns=${dnsName}` : ""),
			);
			return {
				identity: current,
				provider: "tailscale",
				ready: true,
				notes,
			};
		},
		async status() {
			return current;
		},
		async leave() {
			if (current) {
				await options?.metering?.emit(
					createUsageEvent({
						tenantId: current.tenantId,
						eventType: "overlay.leave",
						resource: current.hostname,
						metadata: { provider: "tailscale" },
					}),
				);
			}
			current = null;
		},
		async configureMagicDns(
			config: MagicDnsSplitConfig,
		): Promise<MagicDnsSplitResult> {
			const notes: string[] = [];
			const domains =
				config.domains.length > 0
					? config.domains
					: (options?.defaultMagicDnsDomains ?? ["hobo.test", "hobo.internal"]);
			const nameservers =
				config.nameservers.length > 0
					? config.nameservers
					: ["100.100.100.100"];
			let localAccepted = false;
			let controlPlaneApplied = false;

			// 1) Local CLI: accept MagicDNS on this node.
			const accept = run(["set", "--accept-dns=true"]);
			if (!accept.ok) {
				notes.push(
					`localAccepted=false: ${accept.stderr.trim() || accept.stdout.trim() || "cli error"}`,
				);
			} else {
				localAccepted = true;
				notes.push("localAccepted=true (tailscale set --accept-dns=true)");
			}

			// 2) Control-plane API: push split DNS for hierarchical hobo zones.
			const apiKey =
				options?.apiKey ??
				process.env.TS_API_KEY ??
				process.env.HOBO_TS_API_KEY;
			if (apiKey) {
				try {
					const { createTailscaleApiClient } = await import(
						"./tailscale-api.js"
					);
					const api = createTailscaleApiClient({
						apiKey,
						...(options?.tailnet !== undefined
							? { tailnet: options.tailnet }
							: undefined),
						...(options?.apiBase !== undefined
							? { apiBase: options.apiBase }
							: undefined),
						...(options?.fetchImpl !== undefined
							? { fetchImpl: options.fetchImpl }
							: undefined),
					});
					await api.setDnsPreferences({ magicDNS: true });
					const map = await api.putSplitDns(domains, nameservers);
					controlPlaneApplied = true;
					notes.push(
						`controlPlaneApplied=true split-dns=[${Object.keys(map).join(",")}]`,
					);
				} catch (error) {
					notes.push(
						`controlPlaneApplied=false: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			} else {
				notes.push(
					"controlPlaneApplied=false: TS_API_KEY/HOBO_TS_API_KEY unset",
				);
			}

			// 3) Optional local CLI dns helpers (does not imply control-plane).
			const dnsHelp = run(["dns", "--help"]);
			if (dnsHelp.ok) {
				for (const domain of domains) {
					const attempt = run([
						"dns",
						"set",
						"--domain",
						domain,
						"--nameservers",
						nameservers.join(","),
					]);
					if (attempt.ok) {
						localAccepted = true;
						notes.push(`cli dns set ${domain} ok`);
					}
				}
			}

			notes.push(
				`split-dns domains=[${domains.join(",")}] nameservers=[${nameservers.join(",")}] tenant=${config.tenantId}`,
			);

			// applied means something useful succeeded; control-plane is explicit in notes/metadata.
			const applied = localAccepted || controlPlaneApplied;

			await options?.metering?.emit(
				createUsageEvent({
					tenantId: config.tenantId,
					eventType: "overlay.magicdns",
					resource: domains.join(","),
					metadata: {
						applied,
						localAccepted,
						controlPlaneApplied,
						nameservers: nameservers.join(","),
						api: Boolean(apiKey),
					},
				}),
			);

			return { applied, notes, domains };
		},
		async publishFunnel(
			funnel: FunnelPublishOptions,
		): Promise<FunnelPublishResult> {
			const notes: string[] = [];
			let target: string | null = null;
			try {
				const parsed = new URL(funnel.backendUrl);
				const local = new Set(["localhost", "127.0.0.1", "[::1]"]);
				const effectivePort =
					Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
				if (
					(parsed.protocol === "http:" || parsed.protocol === "https:") &&
					local.has(parsed.hostname) &&
					(funnel.localPort === undefined || funnel.localPort === effectivePort)
				) {
					target = parsed.toString();
				} else {
					notes.push("Funnel target must be a matching local HTTP(S) endpoint");
				}
			} catch {
				notes.push("Funnel target must be an absolute local HTTP(S) URL");
			}

			// Funnel is public; `tailscale serve` is tailnet-private and cannot confirm it.
			const attempts: readonly (readonly string[])[] = target
				? [["funnel", "--bg", target]]
				: [];

			let enabled = false;
			let gatewayHostname: string | null = null;

			for (const args of attempts) {
				const result = run(args);
				if (result.ok) {
					enabled = true;
					const combined = `${result.stdout}\n${result.stderr}`;
					const match =
						combined.match(/https?:\/\/([a-z0-9.-]+\.ts\.net)/i) ??
						combined.match(/([a-z0-9.-]+\.ts\.net)/i);
					if (match?.[1]) {
						gatewayHostname = match[1].toLowerCase();
					}
					notes.push(`funnel command ok: ${args.join(" ")}`);
					break;
				}
				notes.push(
					`funnel attempt failed (${args.join(" ")}): ${result.stderr.trim() || result.stdout.trim() || "error"}`,
				);
			}

			if (!gatewayHostname && funnel.hostnameHint) {
				// Only accept *.ts.net style hints — never raw IPs.
				const hint = funnel.hostnameHint.replace(/\.$/, "").toLowerCase();
				if (hint.endsWith(".ts.net") || hint.endsWith(".tailscale.com")) {
					gatewayHostname = hint;
					notes.push(`using hostnameHint gateway ${hint}`);
				} else {
					notes.push(
						`hostnameHint rejected (must be authenticated funnel host): ${hint}`,
					);
				}
			}

			if (!gatewayHostname && current) {
				// Derive from MagicDNS name if available via status.
				const status = run(["status", "--json"]);
				if (status.ok) {
					try {
						// SAFETY: assertion required at this I/O or test boundary.
						const parsed = JSON.parse(status.stdout) as {
							Self?: { DNSName?: string };
						};
						const dns = parsed.Self?.DNSName?.replace(/\.$/, "");
						if (dns?.endsWith(".ts.net")) {
							gatewayHostname = dns;
							notes.push(`derived funnel host from MagicDNS ${dns}`);
						}
					} catch {
						// ignore
					}
				}
			}

			if (!enabled && !gatewayHostname) {
				notes.push(
					"Funnel not enabled; install/login tailscale and enable Funnel in ACL, or pass hostnameHint ending in .ts.net",
				);
			}

			funnel.emitProgress?.(
				gatewayHostname
					? `hobo funnel: gateway ${gatewayHostname} → ${funnel.backendUrl}`
					: `hobo funnel: not ready (${notes[notes.length - 1] ?? "unknown"})`,
			);

			const result: FunnelPublishResult = {
				enabled,
				confirmed: enabled,
				gatewayHostname,
				notes,
			};

			try {
				await options?.metering?.emit(
					createUsageEvent({
						tenantId: funnel.tenantId,
						eventType: "overlay.funnel",
						resource: gatewayHostname ?? "funnel",
						metadata: {
							enabled: result.enabled,
							gateway: gatewayHostname ?? "",
						},
					}),
				);
			} catch {
				// A confirmed provider side effect remains authoritative.
			}

			return result;
		},
	};
}

export function parseTenantTag(tags: readonly string[]): TenantId | null {
	const hit = tags.find((t) => t.startsWith("tenant:"));
	if (!hit) return null;
	return parseTenantId(hit.slice("tenant:".length));
}
