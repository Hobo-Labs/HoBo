import * as Domain from "@alchemy.run/domain";
import * as Layer from "effect/Layer";
import { AuthSession } from "./AuthSession.aggregate.js";
import { AuthWorkspace } from "./AuthWorkspace.aggregate.js";
import {
	BootstrapAuthWorkspace,
	BootstrapAuthWorkspaceLive,
} from "./BootstrapAuthWorkspace.saga.js";
import {
	SessionRevocationPolicy,
	SessionRevocationPolicyLive,
	StartBootstrapPolicy,
	StartBootstrapPolicyLive,
} from "./Onboarding.policies.js";
import {
	ActiveSessionView,
	ActiveSessionViewLive,
	WorkspaceOnboardingView,
	WorkspaceOnboardingViewLive,
} from "./views.js";

export class AuthOnboarding extends Domain.Model(
	"AuthOnboarding",
	{
		aggregates: [AuthWorkspace, AuthSession],
		views: [WorkspaceOnboardingView, ActiveSessionView],
		policies: [StartBootstrapPolicy, SessionRevocationPolicy],
		sagas: [BootstrapAuthWorkspace],
	},
	{
		description:
			"HoBo auth onboarding, owner-vault signing-key verification, Better Auth issuer bootstrap, and cross-restart/cross-box session lifecycle model.",
	},
) {}

export class AuthOnboardingApi extends Domain.Api(
	"AuthOnboardingApi",
	{
		model: AuthOnboarding,
		commands: [
			"BeginOnboarding",
			"ConfigureBetterAuthIssuer",
			"AuthorizeBox",
			"RotateSigningKey",
			"EstablishAuthSession",
			"ResumeAuthSession",
			"RefreshAuthSession",
			"RevokeAuthSession",
		],
		views: ["WorkspaceOnboardingView", "ActiveSessionView"],
	},
	{
		description:
			"Authenticated control API for HoBo Alchemy auth onboarding and reusable cross-box sessions.",
	},
) {}

export const AuthOnboardingHandlers = Layer.mergeAll(
	StartBootstrapPolicyLive,
	SessionRevocationPolicyLive,
	BootstrapAuthWorkspaceLive,
	WorkspaceOnboardingViewLive,
	ActiveSessionViewLive,
);
