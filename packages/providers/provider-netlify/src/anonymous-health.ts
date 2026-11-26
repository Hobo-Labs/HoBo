import {
	assertAllowedEndpoint,
	createBoundedFetchTransport,
	type HttpTransport,
} from "@hobo/core";
import type { NetlifyAnonymousHealthObservationRecord } from "./_generated/anonymous_health_pb.js";
import { assertClaimActionIsNetlify } from "./deploy-output.js";

export type NetlifyAnonymousHealthObservation = Readonly<
	Pick<
		NetlifyAnonymousHealthObservationRecord,
		"httpStatus" | "markerObserved" | "passwordGateObserved"
	>
>;
function observation(
	httpStatus: number,
	markerObserved: boolean,
	passwordGateObserved: boolean,
): NetlifyAnonymousHealthObservation {
	if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)
		throw new Error("Netlify health response has no valid HTTP status");
	return { httpStatus, markerObserved, passwordGateObserved };
}

/** Observe the deployed bytes without claiming ownership. Netlify Drop uses a
 * password form followed by an origin-scoped cookie, not HTTP Basic auth. The
 * claim secret and session cookie never leave this call's memory. */
export async function observeNetlifyAnonymousSite(input: {
	readonly stationUrl: string;
	readonly claimUrl: string;
	readonly expectedMarker: string;
	readonly transport?: HttpTransport;
}): Promise<NetlifyAnonymousHealthObservation> {
	assertClaimActionIsNetlify(input.claimUrl);
	const station = new URL(input.stationUrl);
	if (
		station.protocol !== "https:" ||
		!station.hostname.endsWith(".netlify.app") ||
		station.username ||
		station.password ||
		station.port ||
		station.search ||
		station.hash
	)
		throw new Error(
			"Netlify anonymous health target leaves its deployment origin",
		);
	if (!input.expectedMarker || input.expectedMarker.length > 4096)
		throw new Error(
			"Netlify health requires a bounded expected artifact marker",
		);
	assertAllowedEndpoint(station.toString(), {
		allowedHosts: [station.hostname],
		allowedPathPrefixes: ["/"],
		maxTimeoutMs: 15000,
		maxResponseBytes: 524288,
	});
	// Login's 302 is inspected locally; no redirect is followed by the bounded fetch adapter.
	const dispatch =
		input.transport ??
		createBoundedFetchTransport({ fetchImpl: globalThis.fetch });
	const send = (
		method: "GET" | "POST",
		headers: Readonly<Record<string, string>> = {},
		body?: string,
	) =>
		dispatch({
			method,
			url: station.toString(),
			headers,
			timeoutMs: 15000,
			maxResponseBytes: 524288,
			...(body === undefined ? undefined : { body }),
		});
	const first = await send("GET");
	if (first.status !== 401)
		return observation(
			first.status,
			first.status === 200 && first.body.includes(input.expectedMarker),
			false,
		);
	const claim = new URL(input.claimUrl),
		password =
			new URLSearchParams(claim.hash.slice(1)).get("password") ??
			claim.searchParams.get("password");
	if (
		!password ||
		password.length > 4096 ||
		!first.body.includes('name="password"')
	)
		return observation(first.status, false, true);
	const login = await send(
		"POST",
		{ "content-type": "application/x-www-form-urlencoded" },
		new URLSearchParams({ "form-name": "form 1", password }).toString(),
	);
	const setCookie = login.headers["set-cookie"];
	if (![302, 303].includes(login.status) || !setCookie)
		return observation(login.status, false, true);
	const location = login.headers.location;
	if (
		location !== undefined &&
		new URL(location, station).origin !== station.origin
	)
		throw new Error(
			"Netlify password gate redirected outside the deployment origin",
		);
	const cookie = setCookie.split(";", 1)[0];
	if (!cookie || /[\r\n]/u.test(cookie) || cookie.length > 8192)
		throw new Error(
			"Netlify password gate returned an invalid origin-scoped session",
		);
	const observed = await send("GET", { cookie });
	return observation(
		observed.status,
		observed.status === 200 && observed.body.includes(input.expectedMarker),
		true,
	);
}
