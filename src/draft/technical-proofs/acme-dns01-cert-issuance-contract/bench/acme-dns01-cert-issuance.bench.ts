import { bench, describe } from "vitest";

import { createInMemoryDnsAdapter } from "../../hobo-dns-port-contract/src/dns-port.js";
import {
	createFixtureAcmeDns01Endpoint,
	createFixtureIdentityCertificateAuthority,
	requestAcmeDns01Certificate,
} from "../src/acme-dns01-cert-issuance.ts";

// Numbers are advisory; the gate only requires that declared benches EXECUTE.
describe("acme dns-01 issuance hot path", () => {
	const now = () => new Date("2026-06-27T16:00:00.000Z");
	const identity = createFixtureIdentityCertificateAuthority({
		issuer: "identity://yard-prod",
		now,
	});

	bench("prepareDns01Order (csr digest + challenge derivation)", () => {
		identity.prepareDns01Order({
			domain: "shop.com",
			camp: "prod-us",
			camps: ["prod-us", "prod-eu"],
			subjectNames: ["shop.com", "*.shop.com"],
		});
	});

	bench("full DNS-01 issuance (stage + validate + finalize)", async () => {
		const dnsAdapter = createInMemoryDnsAdapter({ id: "dns-bench" });
		await requestAcmeDns01Certificate({
			domain: "shop.com",
			camp: "prod-us",
			dnsAdapter,
			identity,
			acme: createFixtureAcmeDns01Endpoint({ dnsAdapter }),
		});
	});
});
