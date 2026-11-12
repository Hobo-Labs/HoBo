/* oxlint-disable no-unused-vars -- contract commit: entry-point stubs keep their final signatures until a lane implements them. */
/**
 * Person sign-in (L30): browser and device-code flows, the person's
 * confirmation, and DPoP-bound person credentials. Re-exported by
 * `@hobo/fleet/membership`; `createEnrollmentAuthority` takes it as a part.
 *
 * Contract commit: the body throws `FleetNotImplemented`; L30 replaces it.
 */
import type {
	ApprovalDecision,
	ApprovalResult,
	ApprovalView,
	PersonCredential,
	SignInCallback,
	SignInChallenge,
	SignInComplete,
	SignInDeviceCode,
	SignInPoll,
	SignInStart,
} from "../_generated/fleet_pb.js";
import { FleetNotImplemented } from "../errors.js";
import type { AuthorityDeps, Outcome, VerifiedToken } from "../ports.js";

export function createSignIn(
	deps: Pick<
		AuthorityDeps,
		| "tenant"
		| "store"
		| "bus"
		| "issuer"
		| "directory"
		| "signIn"
		| "now"
		| "log"
	>,
): Readonly<{
	start(request: SignInStart): Promise<Outcome<SignInChallenge>>;
	device(request: SignInDeviceCode): Promise<Outcome<SignInChallenge>>;
	callback(request: SignInCallback): Promise<Outcome<ApprovalView>>;
	approval(state: string): Promise<Outcome<ApprovalView>>;
	approve(request: ApprovalDecision): Promise<Outcome<ApprovalResult>>;
	complete(
		request: SignInComplete,
		dpop: string,
	): Promise<Outcome<PersonCredential>>;
	/** `sign-in-pending` until the person has confirmed; then the credential, once. */
	poll(request: SignInPoll, dpop: string): Promise<Outcome<PersonCredential>>;
	refresh(
		caller: VerifiedToken,
		dpop: string,
	): Promise<Outcome<PersonCredential>>;
}> {
	throw new FleetNotImplemented("createSignIn");
}
