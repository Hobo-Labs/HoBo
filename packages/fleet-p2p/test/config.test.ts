import { FleetParseError } from "@hobo/fleet";
import { describe, expect, it } from "vitest";
import { parseRelayUrls } from "../src/config.js";
import { createP2pTransport } from "../src/index.js";

describe("relay URLs", () => {
	it("accepts https relays and plain-http relays on a loopback address", () => {
		expect(
			parseRelayUrls([
				"https://relay.fleet.example/",
				"http://127.0.0.1:3340",
				"http://localhost:3340/",
				"http://[::1]:3340",
			]),
		).toEqual([
			"https://relay.fleet.example/",
			"http://127.0.0.1:3340/",
			"http://localhost:3340/",
			"http://[::1]:3340/",
		]);
		expect(parseRelayUrls([])).toEqual([]);
	});

	it.each([
		"http://relay.fleet.example/",
		"ftp://relay.fleet.example/",
		"not a url",
		"https://user:secret@relay.fleet.example/",
	])("refuses %s", (url) => {
		expect(() => parseRelayUrls([url])).toThrow(FleetParseError);
	});

	it("refuses a duplicate relay", () => {
		expect(() =>
			parseRelayUrls([
				"https://relay.fleet.example",
				"https://relay.fleet.example/",
			]),
		).toThrow(FleetParseError);
	});

	it("createP2pTransport parses its relays before anything is bound", () => {
		expect(() =>
			createP2pTransport({ relayUrls: ["http://relay.fleet.example/"] }),
		).toThrow(FleetParseError);
		expect(
			createP2pTransport({ relayUrls: ["https://relay.fleet.example/"] }).kind,
		).toBe("p2p");
	});
});
