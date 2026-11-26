/**
 * `hobo replay` — Session Replay observe surface (ADR-0137).
 *
 * Subcommands: list | get | open | summarize | retention | doctor
 * Distinct from control-plane event-log replay and from auth session.* events.
 * Mutations for retention/erase are local dual-fixture ops; production view
 * remains policy/PAM gated inside @hobo/replay.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandModule } from "@hobo/cli";
import { must } from "@hobo/core/total-access";
import {
	createContractAssertedReplayFixtures,
	createReplayService,
	type ReplayService,
} from "@hobo/replay";
import { loadHoboProfile } from "./hobo-profile.js";
import { isJsonString, type JsonObject } from "./json.js";

export interface ReplayCommandDeps {
	readonly env?: NodeJS.ProcessEnv;
	readonly hoboHome?: string;
	/** Injectable service for tests. */
	readonly service?: ReplayService;
}

const SUBCOMMANDS = [
	"list",
	"get",
	"open",
	"summarize",
	"retention",
	"doctor",
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/** Local HOBO_HOME resolution without pulling Yard/compose graph. */
function defaultHoboHome(env: NodeJS.ProcessEnv = process.env): string {
	if (isJsonString(env.HOBO_HOME) && env.HOBO_HOME.length > 0) {
		return env.HOBO_HOME;
	}
	return join(homedir(), ".hobo");
}

function resolveHome(deps: ReplayCommandDeps): string {
	const env = deps.env ?? process.env;
	return deps.hoboHome ?? defaultHoboHome(env);
}

function resolveStationId(
	deps: ReplayCommandDeps,
	flags: JsonObject,
	home: string,
): string {
	const flag = flags.station ?? flags.id;
	if (isJsonString(flag) && flag.length > 0) return flag;
	const env = deps.env ?? process.env;
	if (isJsonString(env.HOBO_STATION) && env.HOBO_STATION.length > 0) {
		return env.HOBO_STATION;
	}
	const profile = loadHoboProfile(home);
	if (profile?.defaultStation?.id) return profile.defaultStation.id;
	return "station:local";
}

function resolveService(
	deps: ReplayCommandDeps,
	stationId: string,
	home: string,
): ReplayService {
	if (deps.service) return deps.service;
	const env = deps.env ?? process.env;
	// Prefer memory fixtures when HOBO_REPLAY_FIXTURES=1 or no station data dir.
	if (env.HOBO_REPLAY_FIXTURES === "1" || env.HOBO_REPLAY_MEMORY === "1") {
		return createContractAssertedReplayFixtures({ stationId }).service;
	}
	const rootDir = join(
		home,
		"stations",
		stationId.replace(/[:/]/g, "_"),
		"replay",
	);
	return createReplayService({ stationId, rootDir });
}

export function createReplayCommand(
	deps: ReplayCommandDeps = {},
): CommandModule {
	return {
		implemented: true,
		run: async ({ args, flags, emitProgress }) => {
			const env = deps.env ?? process.env;
			const home = resolveHome(deps);
			// SAFETY: assertion required at this I/O or test boundary.
			const flagBag = flags as JsonObject;
			const stationId = resolveStationId(deps, flagBag, home);
			// SAFETY: assertion required at this I/O or test boundary.
			const sub = (args[0] ?? "list") as string;

			// SAFETY: assertion required at this I/O or test boundary.
			if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_REPLAY_USAGE",
					message: `hobo replay: unknown subcommand "${sub}"`,
					remediation: [
						"hobo replay list",
						"hobo replay get <sessionId>",
						"hobo replay open <sessionId>",
						"hobo replay summarize <sessionId>",
						"hobo replay retention",
						"hobo replay doctor",
						"Set HOBO_REPLAY=0 to disable capture; HOBO_REPLAY_FIXTURES=1 for contract fixtures",
					],
					data: { command: "replay", subcommands: [...SUBCOMMANDS] },
				};
			}

			const service = resolveService(deps, stationId, home);

			if (sub === "doctor") {
				const doc = service.doctor();
				emitProgress(`replay doctor: ${doc.package} @ ${doc.stationId}`);
				return {
					ok: true,
					status: "ok",
					code: "HOBO_REPLAY_DOCTOR",
					message: `hobo replay doctor: default local on; kill=${doc.killEnv}`,
					data: {
						command: "replay",
						subcommand: "doctor" satisfies Subcommand,
						...doc,
						envKill: env.HOBO_REPLAY ?? null,
						note: "Session Replay ≠ control-plane event-log replay; events use replay.* family",
					},
				};
			}

			if (sub === "list") {
				const errorId = isJsonString(flagBag.error)
					? flagBag.error
					: isJsonString(flagBag.errorId)
						? flagBag.errorId
						: undefined;
				const trailId = isJsonString(flagBag.trail)
					? flagBag.trail
					: isJsonString(flagBag.trailId)
						? flagBag.trailId
						: undefined;
				const sessions = await service.list({
					...(errorId !== undefined ? { errorId } : undefined),
					...(trailId !== undefined ? { trailId } : undefined),
				});
				emitProgress(`replay list: ${sessions.length} session(s)`);
				return {
					ok: true,
					status: "ok",
					code: "HOBO_REPLAY_LIST",
					message: `hobo replay: ${sessions.length} session(s) at ${stationId}`,
					data: {
						command: "replay",
						subcommand: "list" satisfies Subcommand,
						stationId,
						sessions: sessions.map((s) => ({
							id: s.id,
							status: s.status,
							errorId: s.correlation.errorId,
							trailId: s.correlation.trailId,
							flags: s.correlation.harnessFlagKeys,
							chunkCount: s.chunkCount,
							totalBytes: s.totalBytes,
							summary: s.summary,
						})),
					},
				};
			}

			const sessionId = args[1];
			if (
				(sub === "get" || sub === "open" || sub === "summarize") &&
				(!isJsonString(sessionId) || sessionId.length === 0)
			) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_REPLAY_USAGE",
					message: `hobo replay ${sub}: sessionId required`,
					remediation: [`hobo replay ${sub} <sessionId>`],
					data: { command: "replay", subcommand: sub },
				};
			}

			if (sub === "get") {
				const session = await service.get(must(sessionId));
				if (!session) {
					return {
						ok: false,
						status: "not-found",
						code: "HOBO_REPLAY_NOT_FOUND",
						message: `session not found: ${sessionId}`,
						data: { command: "replay", subcommand: "get", sessionId },
					};
				}
				return {
					ok: true,
					status: "ok",
					code: "HOBO_REPLAY_GET",
					message: `hobo replay get ${session.id}`,
					data: {
						command: "replay",
						subcommand: "get" satisfies Subcommand,
						session,
					},
				};
			}

			if (sub === "summarize") {
				const summary = await service.summarize(must(sessionId));
				if (!summary) {
					return {
						ok: false,
						status: "not-found",
						code: "HOBO_REPLAY_NOT_FOUND",
						message: `session not found: ${sessionId}`,
						data: { command: "replay", subcommand: "summarize", sessionId },
					};
				}
				emitProgress(summary);
				return {
					ok: true,
					status: "ok",
					code: "HOBO_REPLAY_SUMMARIZE",
					message: summary,
					data: {
						command: "replay",
						subcommand: "summarize" satisfies Subcommand,
						sessionId,
						summary,
					},
				};
			}

			if (sub === "open") {
				const opened = await service.open(must(sessionId));
				if (!opened.ok) {
					return {
						ok: false,
						status: "error",
						code: opened.code,
						message: opened.message,
						data: { command: "replay", subcommand: "open", sessionId },
					};
				}
				emitProgress(`replay open: ${opened.summary}`);
				return {
					ok: true,
					status: "ok",
					code: "HOBO_REPLAY_OPEN",
					message: opened.summary,
					data: {
						command: "replay",
						subcommand: "open" satisfies Subcommand,
						summary: opened.summary,
						deepLink: opened.payload.deepLink,
						openUi: opened.payload.openUi,
						eventCount: opened.payload.events.length,
						// Heavy events omitted from CLI envelope by default.
						eventsOmitted: true,
					},
				};
			}

			// retention
			const result = await service.retention();
			emitProgress(
				`replay retention: scanned=${result.scanned} erased=${result.erased}`,
			);
			return {
				ok: true,
				status: "ok",
				code: "HOBO_REPLAY_RETENTION",
				message: `hobo replay retention: erased ${result.erased} of ${result.scanned}`,
				data: {
					command: "replay",
					subcommand: "retention" satisfies Subcommand,
					scanned: result.scanned,
					erased: result.erased,
					retained: result.retained,
					recipe: "replay.retention",
				},
			};
		},
	};
}
