/**
 * `hobo station` — ops/setup family for Station occupancy (NOT a lifecycle verb).
 * up/down remain the only lifecycle verbs for app graphs.
 *
 * Subcommands: init | up | down | status | rails list|publish|approve|activate|status
 *
 * Pure ops delegated to `@hobo/management` (shared with control API + MCP).
 */

import type { CommandModule } from "@hobo/cli";
import {
	createManagementContext,
	stationDown,
	stationInit,
	stationRailsActivate,
	stationRailsApprove,
	stationRailsList,
	stationRailsPublish,
	stationStatus,
	stationUp,
} from "@hobo/management";
import { createStationClient } from "@hobo/stations";
import { defaultHoboHome } from "./bare-metal-yard.js";
import { loadHoboProfile, setDefaultStation } from "./hobo-profile.js";
import { isJsonString, type JsonObject } from "./json.js";

export interface StationCommandDeps {
	readonly env?: NodeJS.ProcessEnv;
	readonly hoboHome?: string;
	readonly log?: (line: string) => void;
}

function flagString(flags: JsonObject, ...names: string[]): string | undefined {
	for (const n of names) {
		const v = flags[n];
		if (isJsonString(v) && v.length > 0) return v;
	}
	return undefined;
}

function resolveHome(deps: StationCommandDeps): string {
	return (
		deps.hoboHome ??
		deps.env?.HOBO_HOME ??
		process.env.HOBO_HOME ??
		defaultHoboHome()
	);
}

function resolveStationId(
	deps: StationCommandDeps,
	flags: JsonObject,
	home: string,
): string {
	const fromFlag = flagString(flags, "station", "id");
	if (fromFlag) return fromFlag;
	const fromEnv = deps.env?.HOBO_STATION ?? process.env.HOBO_STATION;
	if (fromEnv) return fromEnv;
	const profile = loadHoboProfile(home);
	if (profile?.defaultStation?.id) return profile.defaultStation.id;
	return "station:local";
}

export function createStationCommand(
	deps: StationCommandDeps = {},
): CommandModule {
	return {
		implemented: true,
		async run({ args, flags }) {
			// SAFETY: assertion required at this I/O or test boundary.
			const flagBag = flags as JsonObject;
			const home = resolveHome(deps);
			const log = deps.log ?? ((line: string) => console.error(line));
			const sub = args[0] ?? "status";

			const ctx = createManagementContext({ hoboHome: home });

			if (sub === "init") {
				const name = flagString(flagBag, "name") ?? "local";
				const id = flagString(flagBag, "id") ?? `station:${name}`;
				const tenant = flagString(flagBag, "tenant") ?? name;
				const result = stationInit(ctx, { name, id, tenant });
				if (result.ok && result.data) {
					// SAFETY: assertion required at this I/O or test boundary.
					const data = result.data as {
						stationId: string;
						dataDir: string;
						activeRailHash?: `sha256:${string}`;
					};
					setDefaultStation(
						home,
						{ id: data.stationId, dataDir: data.dataDir },
						data.activeRailHash,
					);
				}
				return result;
			}

			if (sub === "status" || sub === "up" || sub === "down") {
				const stationId = resolveStationId(deps, flagBag, home);
				if (sub === "up") {
					const result = stationUp(ctx, stationId);
					if (result.ok) {
						log(
							// SAFETY: assertion required at this I/O or test boundary.
							`hobo station up: occupancy ready ${stationId} rail=${(result.data as { activeRailHash?: string })?.activeRailHash ?? "none"}`,
						);
						try {
							const client = createStationClient({
								hoboHome: home,
								stationId,
							});
							client.load();
							return {
								...result,
								data: {
									// SAFETY: assertion required at this I/O or test boundary.
									...(result.data as JsonObject),
									pins: client.pins(),
								},
							};
						} catch {
							return result;
						}
					}
					return result;
				}
				if (sub === "down") {
					log(
						`hobo station down: stopped occupancy for ${stationId} (data retained)`,
					);
					return stationDown(ctx, stationId);
				}
				return stationStatus(ctx, stationId);
			}

			if (sub === "rails") {
				const railSub = args[1] ?? "list";
				const stationId = resolveStationId(deps, flagBag, home);

				if (railSub === "list" || railSub === "status") {
					return stationRailsList(ctx, stationId);
				}

				if (railSub === "publish") {
					const docPath = args[2];
					if (!docPath) {
						return {
							ok: false,
							code: "HOBO_ERR",
							message: "usage: hobo station rails publish <rail-doc.json>",
						};
					}
					return stationRailsPublish(ctx, { stationId, docPath });
				}

				if (railSub === "approve" || railSub === "activate") {
					const hash = args[2];
					if (!hash) {
						return {
							ok: false,
							code: "HOBO_ERR",
							message: `usage: hobo station rails ${railSub} <railId|hash>`,
						};
					}
					const result =
						railSub === "approve"
							? stationRailsApprove(ctx, { stationId, hashOrId: hash })
							: stationRailsActivate(ctx, { stationId, hashOrId: hash });
					if (result.ok && railSub === "activate") {
						try {
							const stationClient = createStationClient({
								hoboHome: home,
								stationId,
							});
							stationClient.load();
							const pins = stationClient.pins();
							setDefaultStation(
								home,
								{ id: stationId, dataDir: stationClient.dataDir },
								pins.railHash,
							);
							return {
								...result,
								data: {
									// SAFETY: assertion required at this I/O or test boundary.
									...(result.data as JsonObject),
									pins,
								},
							};
						} catch {
							return result;
						}
					}
					return result;
				}

				return {
					ok: false,
					code: "HOBO_ERR",
					message: `unknown rails subcommand: ${railSub}`,
				};
			}

			return {
				ok: false,
				message: `unknown station subcommand: ${sub}`,
				data: {
					usage:
						"hobo station init|up|down|status|rails list|publish|approve|activate|status",
				},
			};
		},
	};
}
