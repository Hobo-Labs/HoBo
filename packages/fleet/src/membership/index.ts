/* oxlint-disable no-unused-vars -- contract commit: entry-point stubs keep their final signatures until a lane implements them. */
/**
 * `@hobo/fleet/membership` enrollment authority (L02): composes the parts the
 * other authority lanes build (sign-in, recorder, projection, fleet commands,
 * audit) and implements the member and token methods of `FleetApi` itself.
 *
 * Contract commit: the body throws `FleetNotImplemented`; L02 replaces it.
 */
import { FleetNotImplemented } from "../errors.js";
import type {
	AuthorityDeps,
	AuthorityParts,
	EnrollmentAuthority,
} from "../ports.js";

export function createEnrollmentAuthority(
	deps: AuthorityDeps,
	parts: AuthorityParts,
): EnrollmentAuthority {
	throw new FleetNotImplemented("createEnrollmentAuthority");
}
