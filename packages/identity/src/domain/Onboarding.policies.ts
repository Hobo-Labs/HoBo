import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { AuthSession, AuthSessionRevoked } from "./AuthSession.aggregate.js";
import {
	AuthWorkspace,
	BetterAuthIssuerConfigured,
	SigningKeyRotated,
} from "./AuthWorkspace.aggregate.js";
import { BootstrapAuthWorkspace } from "./BootstrapAuthWorkspace.saga.js";
import { BetterAuthIssuerPort } from "./ExternalSystems.js";

export class StartBootstrapPolicy extends Domain.Policy(
	"StartBootstrapPolicy",
	{
		from: AuthWorkspace,
		on: [BetterAuthIssuerConfigured, SigningKeyRotated],
	},
) {}

export const StartBootstrapPolicyLive = StartBootstrapPolicy.toLayer(
	Effect.gen(function* () {
		const bootstrap = yield* BootstrapAuthWorkspace;

		return Effect.fn(function* ({ source, event }) {
			yield* bootstrap.start(source, {
				profileName: event.profileName,
				stage: event.stage,
				vaultProvider: event.vaultProvider,
				signingKeyLocator: event.signingKeyLocator,
				issuerOrigin: event.issuerOrigin,
				basePath: event.basePath,
				storageKind: event.storageKind,
			});
		});
	}),
);

export class SessionRevocationPolicy extends Domain.Policy(
	"SessionRevocationPolicy",
	{
		from: AuthSession,
		on: [AuthSessionRevoked],
	},
) {}

export const SessionRevocationPolicyLive = SessionRevocationPolicy.toLayer(
	Effect.gen(function* () {
		const issuer = yield* BetterAuthIssuerPort;

		return Effect.fn(function* ({ event }) {
			yield* issuer
				.revokeSessionHandle({
					workspaceId: event.workspaceId,
					issuerOrigin: event.issuerOrigin,
					handleDigest: event.handleDigest,
					reason: event.reason,
				})
				.pipe(Effect.catchTag("IssuerSessionInvalid", () => Effect.void));
		});
	}),
);
