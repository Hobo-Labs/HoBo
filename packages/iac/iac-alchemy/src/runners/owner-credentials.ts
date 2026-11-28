import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

const OWNER_CREDENTIAL_LOCATOR =
	/^owner:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class RunnerCredentialError extends Data.TaggedError(
	"RunnerCredentialError",
)<{
	readonly code: "CREDENTIAL_LOCATOR_INVALID" | "CREDENTIAL_RESOLVE_FAILED";
	readonly message: string;
}> {}

export type OwnerCredentialResolver = (
	locator: string,
) => Promise<string> | string;

export function parseOwnerCredentialLocator(locator: string): string {
	if (!OWNER_CREDENTIAL_LOCATOR.test(locator)) {
		throw new RunnerCredentialError({
			code: "CREDENTIAL_LOCATOR_INVALID",
			message: `runner credential locator must use owner://<NAME>: ${locator}`,
		});
	}
	return locator;
}

export function resolveOwnerCredential(
	resolver: OwnerCredentialResolver,
	locator: string,
): Effect.Effect<string, RunnerCredentialError> {
	return Effect.tryPromise({
		try: async () => {
			const validated = parseOwnerCredentialLocator(locator);
			const value = await resolver(validated);
			if (value.trim().length === 0) {
				throw new RunnerCredentialError({
					code: "CREDENTIAL_RESOLVE_FAILED",
					message: `owner credential ${validated} resolved to empty material`,
				});
			}
			return value;
		},
		catch: (cause) =>
			cause instanceof RunnerCredentialError
				? cause
				: new RunnerCredentialError({
						code: "CREDENTIAL_RESOLVE_FAILED",
						message:
							cause instanceof Error
								? cause.message
								: "owner credential resolution failed",
					}),
	});
}
