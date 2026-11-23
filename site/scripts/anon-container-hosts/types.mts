export type AnonContainerHostId =
	| "openpouch-http"
	| "clawdship"
	| "appish-crane"
	| "zerodeploy"
	| "lakebed-anon";

export type AnonContainerDeployKind = "node-source" | "dockerfile" | "oci-image";

export type AnonContainerHostResult = {
	readonly ok: true;
	readonly host: AnonContainerHostId;
	readonly url: string;
	readonly claimUrl?: string;
	readonly expiresAt?: string;
	readonly kind: AnonContainerDeployKind;
	readonly anonymous: true;
	readonly temporary: true;
	readonly mocked?: boolean;
	readonly detail?: string;
};

export class AnonContainerHostError extends Error {
	readonly host: AnonContainerHostId;
	readonly status?: number;

	constructor(
		host: AnonContainerHostId,
		message: string,
		status?: number,
	) {
		super(message);
		this.name = "AnonContainerHostError";
		this.host = host;
		this.status = status;
	}
}

export type AnonContainerDeployInput = {
	readonly workDir: string;
	readonly projectHint?: string;
	readonly port?: number;
	readonly env?: Readonly<Record<string, string>>;
	readonly mock?: boolean;
	readonly fetchImpl?: typeof fetch;
	readonly signal?: AbortSignal;
};
