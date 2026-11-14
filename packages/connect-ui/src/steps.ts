// The provider-connection flow a lifecycle runs before it converges
// (`hobo ci up` connects GitHub, `hobo cd up` connects Vercel). Each step is
// data: the page renders exactly the component that step needs, and every
// action the page can take is a transition the flow decides, never the page.
//
// Secretless by construction. The flow never shows, accepts or returns a
// secret value: a credential the provider hands back (a GitHub App's private
// key, a Vercel token) goes from the provider's response straight into the
// chosen third-party secret store, and the page only ever sees the store's
// reference to it (`infisical://…`, `op://…`).

/** A third-party secret store the flow can deposit into. */
export interface SecretStoreOption {
	readonly id: "infisical" | "1password" | "bitwarden";
	readonly label: string;
	/** How a workload reads it back without a stored secret. */
	readonly signIn: "oidc" | "service-account";
	readonly recommended: boolean;
}

export type ConnectProvider = "github" | "vercel";

// domain-view: parse-don't-validate parsed/derived step the flow returns; its wire form is ConnectViewRecord.step in data-models/connect_ui.proto.
export type ConnectStep =
	| {
			readonly kind: "choose-secret-store";
			readonly provider: ConnectProvider;
			readonly stores: readonly SecretStoreOption[];
	  }
	| {
			/** GitHub's App manifest flow: the browser posts the manifest. */
			readonly kind: "create-github-app";
			readonly provider: "github";
			readonly appName: string;
			readonly owner: string;
			readonly store: SecretStoreOption["id"];
	  }
	| {
			/** Vercel's OAuth / integration consent screen. */
			readonly kind: "authorize-vercel";
			readonly provider: "vercel";
			readonly team: string | undefined;
			readonly store: SecretStoreOption["id"];
	  }
	| {
			readonly kind: "depositing";
			readonly provider: ConnectProvider;
			readonly store: SecretStoreOption["id"];
			readonly done: number;
			readonly total: number;
	  }
	| {
			readonly kind: "connected";
			readonly provider: ConnectProvider;
			readonly store: SecretStoreOption["id"];
			/** Store references, never values. */
			readonly references: readonly string[];
			readonly nextHint: string;
			readonly link:
				| { readonly label: string; readonly href: string }
				| undefined;
	  }
	| {
			readonly kind: "failed";
			readonly provider: ConnectProvider;
			readonly message: string;
			readonly remediation: readonly string[];
	  };

/** True once the flow cannot take another action. */
export function isTerminalStep(step: ConnectStep): boolean {
	return step.kind === "connected" || step.kind === "failed";
}

/** The actions a connect page may dispatch. The flow decides each one. */
export const CONNECT_ACTIONS = Object.freeze([
	"connect.chooseStore",
	"connect.start",
	"connect.cancel",
] as const);

export type ConnectActionName = (typeof CONNECT_ACTIONS)[number];

const CONNECT_ACTION_SET: ReadonlySet<string> = new Set(CONNECT_ACTIONS);

export function isConnectAction(name: string): name is ConnectActionName {
	return CONNECT_ACTION_SET.has(name);
}

/** The stores HoBo offers by default: Infisical with OIDC first (no secret to hold). */
export const DEFAULT_SECRET_STORES: readonly SecretStoreOption[] =
	Object.freeze([
		Object.freeze({
			id: "infisical",
			label: "Infisical Cloud",
			signIn: "oidc",
			recommended: true,
		}),
		Object.freeze({
			id: "1password",
			label: "1Password",
			signIn: "service-account",
			recommended: false,
		}),
	] as const satisfies readonly SecretStoreOption[]);

const PROVIDER_LABEL: Readonly<Record<ConnectProvider, string>> = Object.freeze(
	{
		github: "GitHub",
		vercel: "Vercel",
	},
);

export function providerLabel(provider: ConnectProvider): string {
	return PROVIDER_LABEL[provider];
}
