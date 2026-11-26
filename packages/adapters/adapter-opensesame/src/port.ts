/**
 * The OpenSesame SecretsPort (ADR-0113 residual port, ADR-0027 ladder rank
 * `provider-federation`): the credential HoBo holds is the run's `osr_`
 * surrogate, which OpenSesame's proxy swaps for the real token at the
 * provider's own host. The real credential never enters HoBo.
 *
 * `access` reads the variable a binding names from the environment the process
 * was started with under `opensesame dev --agent run`, and serves it only when
 * it is shaped like a surrogate AND the same environment carries the markers of
 * a run `runProxied` started: HOBO_OPENSESAME_CHILD=1, NODE_USE_ENV_PROXY=1 and
 * an HTTPS_PROXY on loopback. That is shape plus run markers, not cryptographic
 * provenance: the port cannot ask OpenSesame whether a surrogate is live, so an
 * `osr_` copied from another run into an environment that also fakes all three
 * markers would pass. What it stops is the plain mistakes: a surrogate pasted or
 * left over, served as material, then sent straight to the provider with no proxy. A placeholder (`ostest_`), an absent variable
 * and a plain token the person exported are all denied as `placeholders_only`:
 * a run without the plugin exits 0 and hands the child a placeholder, and
 * against an emulator that accepts any token that is a false green.
 *
 * Secrets enter by a person's `opensesame pass insert`, never through HoBo, so
 * `put` is read-only.
 */

import type { SecretsAccessResult, SecretsPort } from "@hobo/identity";

import {
	isParsedCredentialBinding,
	type ParsedCredentialBinding,
} from "./binding.js";
import { OpenSesameAdapterError } from "./errors.js";
import { CHILD_MARKER, isSurrogate } from "./run-markers.js";

const VERSION = "surrogate";

const LOOPBACK_HOSTS = ["127.0.0.1", "[::1]", "localhost"];

/** What a run started by `runProxied` leaves in the environment, or the first thing missing. */
function missingRunMarker(env: NodeJS.ProcessEnv): string | undefined {
	if (env[CHILD_MARKER] !== "1") return `${CHILD_MARKER} is not 1`;
	if (env.NODE_USE_ENV_PROXY !== "1") return "NODE_USE_ENV_PROXY is not 1";
	const proxy = env.HTTPS_PROXY;
	if (proxy === undefined) return "HTTPS_PROXY is not set";
	try {
		const url = new URL(proxy);
		if (
			url.protocol === "http:" &&
			url.port !== "" &&
			LOOPBACK_HOSTS.includes(url.hostname)
		) {
			return undefined;
		}
	} catch {
		// Not a URL: the same answer.
	}
	return "HTTPS_PROXY is not an http proxy on loopback with a port";
}

export type OpenSesamePortOptions = Readonly<{
	bindings: readonly ParsedCredentialBinding[];
	/** The environment the process was started with; read at each call. */
	env: NodeJS.ProcessEnv;
	id?: string | undefined;
}>;

function valueRefOf(binding: ParsedCredentialBinding): string {
	return `opensesame://${binding.connection.slice("conn://".length)}#${VERSION}`;
}

export function createOpenSesameSecretsPort(
	options: OpenSesamePortOptions,
): SecretsPort {
	if (
		!options.bindings.every((binding) => isParsedCredentialBinding(binding))
	) {
		throw new OpenSesameAdapterError(
			"binding_invalid",
			"the port serves bindings the parser made, not copies or literals",
		);
	}
	const find = (locator: string) =>
		options.bindings.find((binding) => binding.locator === locator);

	function serve(locator: string): SecretsAccessResult {
		const binding = find(locator);
		if (binding === undefined) {
			return {
				status: "denied",
				reason: "no binding for this credential reference",
				code: "secret-not-found",
			};
		}
		const missing = missingRunMarker(options.env);
		if (missing !== undefined) {
			return {
				status: "denied",
				reason: `no_run_provenance: ${missing}, so ${binding.envName} was not delivered by a run started by runProxied`,
				code: "placeholders_only",
			};
		}
		const value = options.env[binding.envName];
		if (value === undefined || !isSurrogate(value)) {
			return {
				status: "denied",
				reason: `${binding.envName} holds a placeholder or nothing, not a surrogate: the run did not deliver one (is the surrogate-proxy plugin installed and on, and the token sealed?)`,
				code: "placeholders_only",
			};
		}
		return {
			status: "ok",
			valueRef: valueRefOf(binding),
			material: value,
			versionId: VERSION,
			source: "provider-federation",
		};
	}

	return {
		id: options.id ?? "secrets:opensesame",
		kind: "opensesame",
		put() {
			return Promise.reject(
				new OpenSesameAdapterError(
					"read_only",
					"secrets enter OpenSesame by `opensesame pass insert`, never through HoBo",
				),
			);
		},
		access(name) {
			return Promise.resolve(serve(name));
		},
		accessVersion(name, versionId) {
			if (versionId !== VERSION) {
				return Promise.resolve({
					status: "denied",
					reason: "only the run's surrogate has a version",
					code: "secret-version-not-found",
				});
			}
			return Promise.resolve(serve(name));
		},
		listVersions(name) {
			return Promise.resolve(find(name) === undefined ? [] : [VERSION]);
		},
	};
}
