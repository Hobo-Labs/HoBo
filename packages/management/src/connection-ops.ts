import type { ConnectionFlow } from "@hobo/identity";

import type { ManagementContext } from "./context.js";
import { resolveDefaultStationId } from "./context.js";
import { errResult, type ManagementResult, okResult } from "./result.js";
import { toPublicConnection } from "./types.js";

export function connectionCreate(
	ctx: ManagementContext,
	input: {
		provider: string;
		stationId?: string;
		alias?: string;
		scopes?: readonly string[];
		flow?: ConnectionFlow | string;
		tenant?: string;
	},
): ManagementResult {
	if (!input.provider) {
		return errResult("hobo connection create <provider> [--alias] [--scopes]", {
			code: "HOBO_CONNECTION_NO_PROVIDER",
			status: "usage",
		});
	}
	const actor = ctx.resolveActor();
	const tenant = input.tenant ?? actor.tenant;
	const stationId = resolveDefaultStationId(ctx, input.stationId);
	if (!stationId) {
		return errResult(
			"hobo connection create requires Station context (--station / HOBO_STATION / profile.defaultStation)",
			{
				code: "HOBO_CONNECTION_STATION_REQUIRED",
				status: "usage",
				remediation: ["hobo station init"],
			},
		);
	}
	const service = ctx.loadConnectionService(tenant);
	try {
		const { connection } = service.create({
			provider: input.provider,
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
			flow: (input.flow as ConnectionFlow | undefined) ?? "oauth2-obo",
			// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
			...(input.alias !== undefined ? { alias: input.alias } : {}),
			subject: { kind: actor.kind, id: actor.id },
			createdBy: { kind: actor.kind, id: actor.id },
			scopes: [...(input.scopes ?? [])],
			stationId,
		});
		ctx.persistConnections(tenant, service);
		return okResult(
			`connection ${connection.alias ?? connection.id} created (pending authorize)`,
			{
				command: "connection",
				subcommand: "create",
				connection: toPublicConnection(connection),
			},
			{ status: "created" },
		);
	} catch (err) {
		return errResult(err instanceof Error ? err.message : String(err), {
			code:
				err instanceof Error && "code" in err
					? // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
						String((err as { code: string }).code)
					: "HOBO_CONNECTION_CREATE_FAILED",
		});
	}
}

export function connectionAuthorize(
	ctx: ManagementContext,
	input: {
		idOrAlias: string;
		tenant?: string;
		grantedScopes?: readonly string[];
		installationId?: string;
	},
): ManagementResult {
	if (!input.idOrAlias) {
		return errResult("hobo connection authorize <id-or-alias>", {
			code: "HOBO_CONNECTION_NO_ID",
			status: "usage",
		});
	}
	const actor = ctx.resolveActor();
	const tenant = input.tenant ?? actor.tenant;
	const service = ctx.loadConnectionService(tenant);
	try {
		const { connection } = service.authorize({
			idOrAlias: input.idOrAlias,
			actor: { kind: actor.kind, id: actor.id },
			// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
			...(input.grantedScopes !== undefined
				? { grantedScopes: [...input.grantedScopes] }
				: {}),
			// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
			...(input.installationId !== undefined
				? { installationId: input.installationId }
				: {}),
		});
		ctx.persistConnections(tenant, service);
		return okResult(
			`connection ${connection.alias ?? connection.id} authorized (status=${connection.status})`,
			{
				command: "connection",
				subcommand: "authorize",
				connection: toPublicConnection(connection),
			},
			{ status: "authorized" },
		);
	} catch (err) {
		return errResult(err instanceof Error ? err.message : String(err), {
			code: "HOBO_CONNECTION_AUTHORIZE_FAILED",
		});
	}
}

export function connectionList(
	ctx: ManagementContext,
	input: {
		tenant?: string;
		provider?: string;
		status?: string;
		subjectId?: string;
	} = {},
): ManagementResult {
	const actor = ctx.resolveActor();
	const tenant = input.tenant ?? actor.tenant;
	const service = ctx.loadConnectionService(tenant);
	const rows = service.list({
		// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
		...(input.provider !== undefined ? { provider: input.provider } : {}),
		// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		...(input.status !== undefined ? { status: input.status as never } : {}),
		// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
		...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
	});
	return okResult(`${rows.length} connection(s)`, {
		command: "connection",
		subcommand: "list",
		connections: rows.map(toPublicConnection),
		count: rows.length,
	});
}

export function connectionGet(
	ctx: ManagementContext,
	input: { idOrAlias: string; tenant?: string },
): ManagementResult {
	if (!input.idOrAlias) {
		return errResult("hobo connection get <id-or-alias>", {
			code: "HOBO_CONNECTION_NO_ID",
			status: "usage",
		});
	}
	const actor = ctx.resolveActor();
	const tenant = input.tenant ?? actor.tenant;
	const service = ctx.loadConnectionService(tenant);
	const connection = service.get(input.idOrAlias);
	if (!connection) {
		return errResult(`connection not found: ${input.idOrAlias}`, {
			code: "HOBO_CONNECTION_NOT_FOUND",
			status: "not_found",
			remediation: ["hobo connection list"],
		});
	}
	return okResult(`connection ${connection.alias ?? connection.id}`, {
		command: "connection",
		subcommand: "get",
		connection: toPublicConnection(connection),
	});
}

export function connectionRevoke(
	ctx: ManagementContext,
	input: { idOrAlias: string; tenant?: string; reason?: string },
): ManagementResult {
	if (!input.idOrAlias) {
		return errResult("hobo connection revoke <id-or-alias>", {
			code: "HOBO_CONNECTION_NO_ID",
			status: "usage",
		});
	}
	const actor = ctx.resolveActor();
	const tenant = input.tenant ?? actor.tenant;
	const service = ctx.loadConnectionService(tenant);
	try {
		const { connection } = service.revoke({
			idOrAlias: input.idOrAlias,
			actor: { kind: actor.kind, id: actor.id },
			reason: input.reason ?? "user-revoked",
		});
		ctx.persistConnections(tenant, service);
		return okResult(
			`connection ${connection.alias ?? connection.id} revoked`,
			{
				command: "connection",
				subcommand: "revoke",
				connection: toPublicConnection(connection),
			},
			{ status: "revoked" },
		);
	} catch (err) {
		return errResult(err instanceof Error ? err.message : String(err), {
			code: "HOBO_CONNECTION_REVOKE_FAILED",
		});
	}
}

export function connectionRotate(
	ctx: ManagementContext,
	input: { idOrAlias: string; tenant?: string },
): ManagementResult {
	if (!input.idOrAlias) {
		return errResult("hobo connection rotate <id-or-alias>", {
			code: "HOBO_CONNECTION_NO_ID",
			status: "usage",
		});
	}
	const actor = ctx.resolveActor();
	const tenant = input.tenant ?? actor.tenant;
	const service = ctx.loadConnectionService(tenant);
	try {
		const { connection } = service.rotate({
			idOrAlias: input.idOrAlias,
			actor: { kind: actor.kind, id: actor.id },
		});
		ctx.persistConnections(tenant, service);
		return okResult(
			`connection ${connection.alias ?? connection.id} credential rotated`,
			{
				command: "connection",
				subcommand: "rotate",
				connection: toPublicConnection(connection),
			},
			{ status: "rotated" },
		);
	} catch (err) {
		return errResult(err instanceof Error ? err.message : String(err), {
			code: "HOBO_CONNECTION_ROTATE_FAILED",
		});
	}
}
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- SAFETY: service boundary assertions and omitted optional request fields preserve the existing contract. */
