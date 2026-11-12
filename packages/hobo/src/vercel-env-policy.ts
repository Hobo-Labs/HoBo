// @hobo/hobo — which project environment variables the Vercel client may set.
//
// `createVercelClient().setProjectEnv` sets NON-SECRET configuration only. A
// connection string, a token, a key or a signing secret reaches a Vercel
// project from its operator or from a storage integration, never from this
// code: nothing here is handed one, and nothing here sends one. So a variable
// is screened by its NAME before any request is formed, and its value is
// screened too, because a credential under an innocent name is still a
// credential. The screen fails closed: a name it is unsure of is refused, and
// the operator sets that one by hand.

import {
	isForbiddenSecretEnvKey,
	looksLikeSecretEnvValue,
} from "@hobo/bindles";
import { redactProviderText } from "@hobo/provider-vercel";

// A name Vercel accepts for an environment variable.
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/u;

// A word of a name (its `_`-separated parts) that names a credential.
const CREDENTIAL_WORD =
	/^(?:TOKENS?|SECRETS?|PASSWORDS?|PASSWD|PASSPHRASE|PWD|PRIVATE|CREDENTIALS?|CREDS|KEYS?|APIKEY|AUTH|AUTHORIZATION|BEARER|COOKIE|DSN|SIGNATURE|SALT|CERT|PEM)$/u;

// The same words run together with others (`ACCESSTOKEN`, `MYSECRET`).
const CREDENTIAL_INFIX = /TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|APIKEY/u;

// Names a storage integration owns: it writes the connection strings itself.
// The relay's cache backends (ADR-0179) are among them: Upstash and Vercel KV
// (`UPSTASH_*`, `KV_*`, `REDIS_*`), Turso (`TURSO_*`, `LIBSQL_*`), Vercel Blob
// (`BLOB_*`) and a Valkey URL held in the config service (`VALKEY_*`).
const STORAGE_NAME =
	/^(?:DATABASE|POSTGRES|PG[A-Z]*|REDIS|MONGO[A-Z]*|MYSQL|KV|BLOB|EDGE_CONFIG|TURSO|LIBSQL|UPSTASH|VALKEY)(?:_|$)/u;

/**
 * The config service's coordinates: where a deployment signs in and what it
 * reads, never what it signs in with (`@hobo/adapter-infisical`,
 * `infisicalBindingFromEnv`; ADR-0179). These are plain configuration, so a
 * deploy may set them; every other `INFISICAL_*` name (an access token, a
 * Universal Auth client id or secret, anything new) is refused.
 */
export const CONFIG_SERVICE_COORDINATES: ReadonlySet<string> = new Set([
	"INFISICAL_ENVIRONMENT",
	"INFISICAL_IDENTITY_ID",
	"INFISICAL_PROJECT_ID",
	"INFISICAL_SECRET_PATH",
	"INFISICAL_SITE_URL",
]);

// Names the config service's own tooling reads.
const CONFIG_SERVICE_NAME = /^INFISICAL(?:_|$)/u;

// The most of a value this path sends; Vercel's own limit is far higher.
const ENV_VALUE_LIMIT = 4096;

// A control character, which no configuration value needs and a log line
// cannot show.
const CONTROL_CHAR = /\p{Cc}/u;

/**
 * Why `setProjectEnv` refuses the name `key`, or undefined when it may be set.
 * The reason never quotes a value.
 */
export function refusedEnvKeyReason(key: string): string | undefined {
	if (!ENV_KEY.test(key))
		return "is not an environment variable name (letters, digits and _, not starting with a digit)";
	// A coordinate is checked before the credential words: `SECRET` in
	// `INFISICAL_SECRET_PATH` names a folder, not a secret.
	if (CONFIG_SERVICE_COORDINATES.has(key)) return undefined;
	const upper = key.toUpperCase();
	if (CONFIG_SERVICE_NAME.test(upper))
		return "names a config-service credential, or a config-service setting that is not one of its coordinates";
	if (isForbiddenSecretEnvKey(key) || STORAGE_NAME.test(upper))
		return "names a connection string or a storage integration's variable";
	if (
		upper.split("_").some((word) => CREDENTIAL_WORD.test(word)) ||
		CREDENTIAL_INFIX.test(upper)
	)
		return "names a credential";
	return undefined;
}

/** True when `key` is a name this path will never set (`refusedEnvKeyReason`). */
export function isRefusedEnvKey(key: string): boolean {
	return refusedEnvKeyReason(key) !== undefined;
}

/**
 * Why `setProjectEnv` refuses the value of the variable `key`, or undefined
 * when it may be sent. The reason names the variable and never the value.
 */
export function refusedEnvValueReason(value: string): string | undefined {
	if (value.length > ENV_VALUE_LIMIT)
		return `is longer than ${ENV_VALUE_LIMIT} characters`;
	if (CONTROL_CHAR.test(value) || value !== value.trim())
		return "holds a control character, or starts or ends with whitespace";
	if (
		looksLikeSecretEnvValue(value) ||
		redactProviderText(value, ENV_VALUE_LIMIT) !== value
	)
		return "looks like a credential";
	return undefined;
}
