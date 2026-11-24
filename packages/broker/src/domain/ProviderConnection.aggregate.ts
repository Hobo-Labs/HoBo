import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { ConnectionLifecycleState, ProviderConnectionId } from "./ids.js";

export class ConnectionAlreadyRevoked extends Domain.Rejection(
	"ConnectionAlreadyRevoked",
	{
		providerId: Schema.String,
	},
) {}

export class ConnectionNotAuthorized extends Domain.Rejection(
	"ConnectionNotAuthorized",
	{
		status: ConnectionLifecycleState,
	},
) {}

export class ProviderConnectionAuthorized extends Domain.Event(
	"ProviderConnectionAuthorized",
	{
		providerId: Schema.String,
		stationId: Schema.String,
		scopeRef: Schema.String,
	},
) {}

export class ProviderConnectionRevoked extends Domain.Event(
	"ProviderConnectionRevoked",
	{
		providerId: Schema.String,
		reason: Schema.String,
	},
) {}

export class AuthorizeProviderConnection extends Domain.Command(
	"AuthorizeProviderConnection",
	{
		target: ProviderConnectionId,
		input: {
			providerId: Schema.String,
			stationId: Schema.String,
			scopeRef: Schema.String,
		},
		events: [ProviderConnectionAuthorized],
		rejects: [ConnectionAlreadyRevoked],
	},
	{ description: "Authorize a station-scoped provider connection." },
) {}

export class RevokeProviderConnection extends Domain.Command(
	"RevokeProviderConnection",
	{
		target: ProviderConnectionId,
		input: {
			reason: Schema.String,
		},
		events: [ProviderConnectionRevoked],
		rejects: [ConnectionNotAuthorized, ConnectionAlreadyRevoked],
	},
	{ description: "Permanently revoke an authorized provider connection." },
) {}

const ProviderConnectionState = Schema.Struct({
	status: ConnectionLifecycleState,
	providerId: Schema.NullOr(Schema.String),
	stationId: Schema.NullOr(Schema.String),
	scopeRef: Schema.NullOr(Schema.String),
	revocationReason: Schema.NullOr(Schema.String),
});

export class ProviderConnection extends Domain.Aggregate("ProviderConnection", {
	id: ProviderConnectionId,
	state: ProviderConnectionState,
	initial: {
		status: "uninitialized" as const,
		providerId: null,
		stationId: null,
		scopeRef: null,
		revocationReason: null,
	},
	commands: [AuthorizeProviderConnection, RevokeProviderConnection],
	decide: {
		AuthorizeProviderConnection: (state, cmd) => {
			if (state.status === "revoked") {
				return new ConnectionAlreadyRevoked({
					providerId: state.providerId ?? cmd.providerId,
				});
			}
			return [
				new ProviderConnectionAuthorized({
					providerId: cmd.providerId,
					stationId: cmd.stationId,
					scopeRef: cmd.scopeRef,
				}),
			];
		},
		RevokeProviderConnection: (state, cmd) => {
			if (state.status === "revoked") {
				return new ConnectionAlreadyRevoked({
					providerId: state.providerId ?? "unknown",
				});
			}
			if (state.status !== "authorized") {
				return new ConnectionNotAuthorized({ status: state.status });
			}
			return [
				new ProviderConnectionRevoked({
					providerId: state.providerId ?? "unknown",
					reason: cmd.reason,
				}),
			];
		},
	},
	evolve: {
		ProviderConnectionAuthorized: (state, event) => ({
			...state,
			status: "authorized" as const,
			providerId: event.providerId,
			stationId: event.stationId,
			scopeRef: event.scopeRef,
		}),
		ProviderConnectionRevoked: (state, event) => ({
			...state,
			status: "revoked" as const,
			revocationReason: event.reason,
		}),
	},
}) {}
