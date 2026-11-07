import type { HttpTransport, TransportRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { observeNetlifyAnonymousSite } from "../src/anonymous-health.js";

const stationUrl = "https://owned.netlify.app/";
const claimUrl =
	"https://app.netlify.com/drop/owned#drop_token=secret-claim&password=secret-password";
describe("anonymous deployment data-plane health", () => {
	it("uses the observed password form and keeps its cookie on the exact deployment origin", async () => {
		const calls: TransportRequest[] = [];
		const transport: HttpTransport = async (request) => {
			calls.push(request);
			if (calls.length === 1)
				return {
					status: 401,
					headers: {},
					body: '<form method="post"><input name="password"></form>',
				};
			if (request.method === "POST")
				return {
					status: 302,
					headers: {
						location: "/",
						"set-cookie": "nf-session=secret-session; Secure; HttpOnly",
					},
					body: "",
				};
			return { status: 200, headers: {}, body: "expected artifact marker" };
		};
		const result = await observeNetlifyAnonymousSite({
			stationUrl,
			claimUrl,
			expectedMarker: "expected artifact marker",
			transport,
		});
		expect(result).toEqual({
			httpStatus: 200,
			markerObserved: true,
			passwordGateObserved: true,
		});
		expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
		expect(calls[1]?.body).toBe("form-name=form+1&password=secret-password");
		expect(calls[2]?.headers.cookie).toBe("nf-session=secret-session");
		expect(
			calls.every((c) => new URL(c.url).origin === new URL(stationUrl).origin),
		).toBe(true);
		expect(JSON.stringify(result)).not.toContain("secret");
	});
	it("does not send a password or cookie to a redirect target", async () => {
		const calls: TransportRequest[] = [];
		const transport: HttpTransport = async (request) => {
			calls.push(request);
			return calls.length === 1
				? { status: 401, headers: {}, body: '<input name="password">' }
				: {
						status: 302,
						headers: {
							location: "https://foreign.netlify.app/",
							"set-cookie": "nf-session=value",
						},
						body: "",
					};
		};
		await expect(
			observeNetlifyAnonymousSite({
				stationUrl,
				claimUrl,
				expectedMarker: "marker",
				transport,
			}),
		).rejects.toThrow(/redirect/);
		expect(calls).toHaveLength(2);
	});
	it("refuses foreign origins before sending any claim authority", async () => {
		let sent = false;
		await expect(
			observeNetlifyAnonymousSite({
				stationUrl: "https://netlify.app.evil.example/",
				claimUrl,
				expectedMarker: "marker",
				transport: async () => {
					sent = true;
					throw new Error("sent");
				},
			}),
		).rejects.toThrow(/origin/);
		expect(sent).toBe(false);
	});
	it("does not treat a successful login or unrelated HTTP 200 as artifact health", async () => {
		const transport: HttpTransport = async () => ({
			status: 200,
			headers: {},
			body: "unrelated",
		});
		expect(
			await observeNetlifyAnonymousSite({
				stationUrl,
				claimUrl,
				expectedMarker: "marker",
				transport,
			}),
		).toMatchObject({ markerObserved: false });
	});
});
