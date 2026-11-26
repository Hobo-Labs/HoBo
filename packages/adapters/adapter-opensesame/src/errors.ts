/**
 * Every way the adapter refuses, as one closed set. A caller switches on
 * `code`; the message says what to change and never carries a value: a
 * rejected field is frequently a credential pasted where a reference belongs,
 * so no message here interpolates what it rejected.
 */
export const ADAPTER_ERROR_CODES = [
	/** A binding record or the bindings document does not parse. */
	"binding_invalid",
	/** The command to run is empty, or the launch cannot be built. */
	"launch_invalid",
	/** The `opensesame` executable cannot be started. */
	"opensesame_bin_missing",
	/** The `opensesame` found is writable by others, or does not answer `--version` as opensesame. Nothing was started. */
	"opensesame_bin_untrusted",
	/** No `node`, no env-spec bridge, no `@env-spec/parser` behind it, an `OPENSESAME_NODE` OpenSesame cannot use, an `OPENSESAME_ENV_PARSE` that is relative or not in a trusted place, or no trusted directory left on `PATH` to look `node` up in. */
	"bridge_missing",
	/** A surrogate would have no bounded scope. */
	"scope_unbounded",
	/** A binding names a variable the run depends on (PATH, NODE_OPTIONS, the proxy and CA variables, ...). */
	"reserved_env_name",
	/** The provider is not one OpenSesame brokers for this adapter (aws). */
	"provider_not_brokered",
	/** The child holds a placeholder, or nothing, where a surrogate belongs. */
	"placeholders_only",
	/** The sealed entry cannot be read (wrong passphrase, empty entry). */
	"store_unreadable",
	/** The plugin changed since it was pinned. There is no fallback. */
	"plugin_pin_mismatch",
	/** A surrogate was sent to a host that is not its provider's (exit 77). */
	"tripwire_misdirected",
	/** OpenSesame ended on a signal: told to stop (it revoked the run), killed (the command may still be running), or this process was signalled before OpenSesame was started (nothing was). */
	"signalled",
	/** The child exited non-zero by itself. */
	"child_exit",
	/** This Node cannot send `fetch` through `HTTPS_PROXY`. */
	"node_proxy_unsupported",
	/** This process already is the child of a proxied run. */
	"recursion_guard",
	/** This process already holds a real credential for a provider the run brokers. */
	"real_credential_in_env",
	/** A value would have broken out of the generated `.env.schema`. */
	"schema_injection",
	/** Secrets enter by a person's `opensesame pass insert`, never through HoBo. */
	"read_only",
] as const;

export type OpenSesameAdapterErrorCode = (typeof ADAPTER_ERROR_CODES)[number];

export class OpenSesameAdapterError extends Error {
	readonly code: OpenSesameAdapterErrorCode;

	constructor(code: OpenSesameAdapterErrorCode, message: string) {
		super(message);
		this.name = "OpenSesameAdapterError";
		this.code = code;
	}
}
