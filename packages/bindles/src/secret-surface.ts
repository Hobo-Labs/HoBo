/**
 * Dual `secret` surface (ADR-0027 + ADR-0113):
 *
 * 1. `secret(name)` — residual managed-store resource factory (`hobo:secrets`).
 * 2. `secret.string()` — typed secret field builder for `config({ ... })`.
 *
 * Preferred paths remain identity federation + `secretRef` / `fromBinding`.
 * `hobo:secrets` is residual Nitric-parity only.
 */
import { secret as secretResource } from "./catalog.js";
import { secretField } from "./config-schema.js";
import type { ResourceHandle } from "./types.js";

type SecretResourceFn = (name: string) => ResourceHandle<"secret">;

type SecretSurface = SecretResourceFn & {
	readonly string: typeof secretField.string;
};

function secretCallable(name: string): ResourceHandle<"secret"> {
	return secretResource(name);
}

export const secret: SecretSurface = Object.assign(secretCallable, {
	string: secretField.string,
});
