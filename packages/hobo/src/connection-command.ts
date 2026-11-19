
import type { CommandModule } from "@hobo/cli";
import type { ConnectionService } from "@hobo/identity";
import {
	connectionAuthorize,
	connectionCreate,
	connectionGet,
	connectionList,
	connectionRevoke,
	connectionRotate,
	createManagementContext,
} from "@hobo/management";
import { defaultHoboHome } from "./bare-metal-yard.js";
import { loadHoboProfile } from "./hobo-profile.js";
import { isJsonString, type JsonObject } from "./json.js";

export interface ConnectionCommandDeps {
	readonly env?: NodeJS.ProcessEnv;
	readonly hoboHome?: string;
	readonly service?: ConnectionService;
}

const SUBCOMMANDS = [
	"create",
	"authorize",
	"list",
	"get",
	"revoke",
	"rotate",
] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

function resolveStationId(
	hoboHome: string,
	flags: JsonObject,
	env: NodeJS.ProcessEnv,
): string | undefined {
	const stationFlag = flags.station;
	if (isJsonString(stationFlag) && stationFlag.length > 0) {
		return stationFlag;
	}
	if (isJsonString(env.HOBO_STATION) && env.HOBO_STATION.length > 0) {
		return env.HOBO_STATION;
	}
	return loadHoboProfile(hoboHome)?.defaultStation?.id;
}

export function createConnectionCommand(
	deps: ConnectionCommandDeps = {},
): CommandModule {
	return {
		run: async ({ context, flags, args }) => {
			const f = flags as JsonObject;
			const env =
				deps.env ?? (context as { env?: NodeJS.ProcessEnv }).env ?? process.env;
			const hoboHome =
				deps.hoboHome ??
				(isJsonString(f.home) && f.home.length > 0
					? f.home
					: defaultHoboHome(env));

			const sub = (args[0] ?? "") as Subcommand | "";
			if (!SUBCOMMANDS.includes(sub as Subcommand)) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_CONNECTION_USAGE",
					message: `hobo connection: unknown subcommand '${sub || "(none)"}'`,
					remediation: [
						"Usage: hobo connection <create|authorize|list|get|revoke|rotate> …",
						"Examples:",
						"  hobo connection create asana --alias work --scopes tasks:read,tasks:write",
						"  hobo connection authorize work",
						"  hobo connection list --provider asana",
					],
					data: { command: "connection", subcommands: SUBCOMMANDS },
				};
			}

			if (deps.service) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_CONNECTION_INJECT_UNSUPPORTED",
					message:
						"connection command injectable service is reserved for legacy tests; use @hobo/management fixtures",
					data: { command: "connection", subcommand: sub },
				};
			}

			const ctx = createManagementContext({ hoboHome });
			const tenant =
				isJsonString(f.tenant) && f.tenant.length > 0 ? f.tenant : undefined;
			const stationId = resolveStationId(
				hoboHome,
				flags as JsonObject,
				env,
			);

			if (sub === "create") {
				const provider = args[1];
				if (!provider) {
					return {
						ok: false,
						status: "usage",
						code: "HOBO_CONNECTION_NO_PROVIDER",
						message: "hobo connection create <provider> [--alias] [--scopes]",
						data: { command: "connection", subcommand: "create" },
					};
				}
				const alias = isJsonString(f.alias) ? f.alias : undefined;
				const scopesRaw = isJsonString(f.scopes) ? f.scopes : "";
				const scopes = scopesRaw
					? scopesRaw
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean)
					: [];
				const flow = isJsonString(f.flow) ? f.flow : undefined;
				return connectionCreate(ctx, {
					provider,
					...(alias !== undefined ? { alias } : undefined),
					scopes,
					...(flow !== undefined ? { flow } : undefined),
					...(stationId !== undefined ? { stationId } : undefined),
					...(tenant !== undefined ? { tenant } : undefined),
				});
			}

			if (sub === "authorize") {
				const idOrAlias = args[1];
				if (!idOrAlias) {
					return {
						ok: false,
						status: "usage",
						code: "HOBO_CONNECTION_NO_ID",
						message: "hobo connection authorize <id-or-alias>",
						data: { command: "connection", subcommand: "authorize" },
					};
				}
				const scopesRaw = isJsonString(f.scopes) ? f.scopes : "";
				const grantedScopes = scopesRaw
					? scopesRaw
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean)
					: undefined;
				const installationId = isJsonString(f.installationId)
					? f.installationId
					: undefined;
				return connectionAuthorize(ctx, {
					idOrAlias,
					...(tenant !== undefined ? { tenant } : undefined),
					...(grantedScopes !== undefined ? { grantedScopes } : undefined),
					...(installationId !== undefined ? { installationId } : undefined),
				});
			}

			if (sub === "list") {
				const provider = isJsonString(f.provider) ? f.provider : undefined;
				const status = isJsonString(f.status) ? f.status : undefined;
				const subjectId = isJsonString(f.subject) ? f.subject : undefined;
				return connectionList(ctx, {
					...(tenant !== undefined ? { tenant } : undefined),
					...(provider !== undefined ? { provider } : undefined),
					...(status !== undefined ? { status } : undefined),
					...(subjectId !== undefined ? { subjectId } : undefined),
				});
			}

			if (sub === "get") {
				const idOrAlias = args[1];
				if (!idOrAlias) {
					return {
						ok: false,
						status: "usage",
						code: "HOBO_CONNECTION_NO_ID",
						message: "hobo connection get <id-or-alias>",
						data: { command: "connection", subcommand: "get" },
					};
				}
				return connectionGet(ctx, {
					idOrAlias,
					...(tenant !== undefined ? { tenant } : undefined),
				});
			}

			if (sub === "revoke") {
				const idOrAlias = args[1];
				if (!idOrAlias) {
					return {
						ok: false,
						status: "usage",
						code: "HOBO_CONNECTION_NO_ID",
						message: "hobo connection revoke <id-or-alias>",
						data: { command: "connection", subcommand: "revoke" },
					};
				}
				const reason = isJsonString(f.reason) ? f.reason : "user-revoked";
				return connectionRevoke(ctx, {
					idOrAlias,
					reason,
					...(tenant !== undefined ? { tenant } : undefined),
				});
			}

			const idOrAlias = args[1];
			if (!idOrAlias) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_CONNECTION_NO_ID",
					message: "hobo connection rotate <id-or-alias>",
					data: { command: "connection", subcommand: "rotate" },
				};
			}
			return connectionRotate(ctx, {
				idOrAlias,
				...(tenant !== undefined ? { tenant } : undefined),
			});
		},
	};
}
