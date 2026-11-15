// Who may own the GitHub App, and which ways of hosting the App connection
// support that owner. Resolution reduces to a path that satisfies every
// criterion: a configured host that cannot serve the owner is explained, the
// hosts that can are suggested, and when nothing was pinned the first host
// that satisfies the owner is simply chosen.

export type GithubOwnerKind = "User" | "Organization";

export interface GithubAppOwner {
	readonly kind: GithubOwnerKind;
	readonly login: string;
	readonly id: number;
}

/** GitHub account logins use alphanumerics and single interior hyphens. */
export function validGithubOrganizationLogin(login: string): boolean {
	return /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(login);
}

/** A way of creating and holding the CI GitHub App connection. */
export interface GithubAppHost {
	readonly id: string;
	readonly label: string;
	readonly ownerKinds: readonly GithubOwnerKind[];
}

/** The manifest flow is the only App host wired by this composition. */
export const GITHUB_APP_HOSTS: readonly GithubAppHost[] = Object.freeze([
	Object.freeze({
		id: "manifest",
		label: "HoBo CI App from the reviewed manifest (this machine)",
		ownerKinds: Object.freeze(["User", "Organization"] as const),
	}),
]);

export type GithubAppHostResolution =
	| { readonly ok: true; readonly host: GithubAppHost; readonly note?: string }
	| {
			readonly ok: false;
			readonly message: string;
			readonly suggestions: readonly GithubAppHost[];
	  };

/** Resolve the host for an owner: the pinned one when it can serve, else one that can. */
export function resolveGithubAppHost(
	owner: GithubAppOwner,
	options: {
		readonly configured?: string | undefined;
		readonly hosts?: readonly GithubAppHost[];
	} = {},
): GithubAppHostResolution {
	const hosts = options.hosts ?? GITHUB_APP_HOSTS;
	const able = hosts.filter((host) => host.ownerKinds.includes(owner.kind));
	const pinned =
		options.configured === undefined
			? undefined
			: hosts.find((host) => host.id === options.configured);
	const kind = owner.kind === "User" ? "user" : "organization";
	if (options.configured !== undefined && pinned === undefined)
		return {
			ok: false,
			message: `App host ${options.configured} is not configured or implemented.`,
			suggestions: able,
		};
	if (pinned?.ownerKinds.includes(owner.kind))
		return { ok: true, host: pinned };
	if (pinned !== undefined) {
		const supported = pinned.ownerKinds
			.map((k) => (k === "User" ? "users" : "organizations"))
			.join(" and ");
		const message = `${pinned.label} only supports Apps owned by ${supported}, and ${owner.login} is an ${kind}.`;
		return able.length === 0
			? { ok: false, message, suggestions: [] }
			: { ok: false, message, suggestions: able };
	}
	const first = able[0];
	return first === undefined
		? {
				ok: false,
				message: `No configured way of hosting the App supports an ${kind} owner.`,
				suggestions: [],
			}
		: { ok: true, host: first };
}
