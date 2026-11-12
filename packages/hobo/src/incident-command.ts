/**
 * `hobo incident` — CD failure disposition through `@hobo/cd` (plan 0024).
 *
 * - `status [--camp <a,b>]`: failed, rolled-back and rejected promotions and
 *   open failovers, from the journal (no fixture).
 * - `open --camp <camp> --signal <s> [--reason <text>]`: the CD rollback (D12):
 *   zero exposure, then a Delta to the predecessor Set through the same gate.
 *   An agent principal (HOBO_AGENT_ID) only proposes it unless granted
 *   (ADR-0094); a human or granted principal executes it.
 *
 * `--simulate` is the only fixture path, as for `hobo deploy`.
 */

import { type CampId, PromotionState } from "@hobo/cd";
import type { CommandModule, CommandResult } from "@hobo/cli";
import { cdOk, cdRefused, cdUsage, parseCdFormat } from "./cd-render.js";
import {
	type CdHostOpener,
	isSimulate,
	openDefaultCdHost,
} from "./deploy-command.js";
import { defaultHoboHome } from "./hobo-home.js";
import { isJsonString, type JsonObject } from "./json.js";

export interface IncidentCommandDeps {
	readonly env?: NodeJS.ProcessEnv;
	readonly hoboHome?: string;
	readonly openCd?: CdHostOpener;
}

const USAGE = [
	"hobo incident status [--camp <a,b>]",
	"hobo incident open --camp <camp> --signal slo-burn|apply-failed|verification-failed [--reason <text>]",
] as const;

// public-contract: promotion states an incident reports.
export const INCIDENT_STATES = Object.freeze([
	PromotionState.FAILED,
	PromotionState.ROLLED_BACK,
	PromotionState.REJECTED,
]);

function camps(flags: JsonObject): readonly CampId[] {
	const v = flags.camp;
	const raw = isJsonString(v) ? v : "";
	// SAFETY: opaque Camp ids; the CD modules refuse unknown ones.
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "") as CampId[];
}

export function createIncidentCommand(
	deps: IncidentCommandDeps = {},
): CommandModule {
	return {
		run: async ({ args, flags, context, emitProgress }) => {
			// SAFETY: assertion required at this I/O or test boundary.
			const f = flags as JsonObject;
			const sub = args[0] ?? "status";
			const format = parseCdFormat(f);
			const fmt = format.ok ? format.format : "text";
			if (sub !== "status" && sub !== "open")
				return {
					...cdUsage({
						code: "HOBO_INCIDENT_USAGE",
						subcommand: sub,
						message: `unknown subcommand "${sub}"`,
						usage: USAGE,
					}),
					message: `hobo incident: unknown subcommand "${sub}"`,
					data: { command: "incident", subcommands: ["status", "open"] },
				};
			const env = deps.env ?? process.env;
			const opened = await (deps.openCd ?? openDefaultCdHost)({
				simulate: isSimulate(f),
				cwd: (isJsonString(f.cwd) && f.cwd) || context.cwd,
				env,
				home: deps.hoboHome ?? defaultHoboHome(env),
			});
			if (!opened.ok)
				return cdRefused({
					reasons: opened.reasons,
					subcommand: `incident ${sub}`,
					format: fmt,
				});
			const { host } = opened.value;
			try {
				if (sub === "status") {
					const selected = camps(f);
					const promotions = (
						selected.length === 0
							? await host.cd.promotions.list({ limit: 200 })
							: (
									await Promise.all(
										selected.map((campId) =>
											host.cd.promotions.list({ campId, limit: 200 }),
										),
									)
								).flat()
					).filter((p) => INCIDENT_STATES.includes(p.state));
					const failovers = await host.cd.failover.list({ limit: 200 });
					const result: CommandResult = cdOk({
						code: "HOBO_INCIDENT_STATUS",
						summary:
							promotions.length + failovers.length === 0
								? "incident: no active CD incident"
								: `incident: ${promotions.length} failed/rolled-back promotion(s), ${failovers.length} failover(s)`,
						format: fmt,
						data: {
							command: "incident",
							subcommand: "status",
							simulated: host.simulated,
							active: promotions.length + failovers.length > 0,
							promotions,
							failovers,
							defaultPath: "rollback",
						},
					});
					return result;
				}
				const [campId] = camps(f);
				if (!campId)
					return cdUsage({
						code: "HOBO_INCIDENT_USAGE",
						subcommand: "incident open",
						message: "missing --camp",
						usage: USAGE,
					});
				const signal = (isJsonString(f.signal) && f.signal) || "slo-burn";
				const reason =
					(isJsonString(f.reason) && f.reason) || `incident: ${signal}`;
				emitProgress(`incident open camp=${campId} signal=${signal}`);
				const rolled = await host.cd.promotions.rollback(
					{
						campId,
						reason,
						idempotencyKey: `incident|${campId}|${signal}|${reason}`,
					},
					host.ctx,
				);
				if (!rolled.ok)
					return cdRefused({
						reasons: rolled.reasons,
						subcommand: "incident open",
						format: fmt,
					});
				return cdOk({
					code: rolled.value.proposal
						? "HOBO_INCIDENT_PROPOSED"
						: "HOBO_INCIDENT_OPEN",
					summary: `incident: rollback ${rolled.value.promotionId} for ${campId}${rolled.value.proposal ? " (proposal; awaits a granted principal)" : ""}`,
					format: fmt,
					data: {
						command: "incident",
						subcommand: "open",
						simulated: host.simulated,
						signal,
						campId,
						promotion: rolled.value,
					},
				});
			} finally {
				await opened.value.close();
			}
		},
	};
}
