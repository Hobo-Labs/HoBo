/**
 * The in-process bzip2 decoder and tar reader that unpack the pinned gVisor
 * release (D58: no host `tar` or `bzip2`). The fixtures were made once with
 * the reference tools and are embedded as base64:
 *
 * - MULTI: `bzip2 -1` of the 250 000-byte text `multiText()` builds (three
 *   100 000-byte blocks).
 * - RUNS: `bzip2 -9` of 268 `a` then one `b` (run-length coding past 4).
 * - EMPTY: `bzip2` of nothing.
 * - FIXTURE_TARBALL (see runtime-provision.test.ts): a GNU tar of
 *   `containerd-shim-runsc-v1`, `runsc`, `gvisor-bin/gvisor_sentry`.
 */
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bunzip2 } from "../../src/sandbox/bunzip2.js";
import { extractTarEntries, tarEntryAllowed } from "../../src/sandbox/tar.js";
import { FIXTURE_TARBALL } from "./gvisor-fixture.js";

const MULTI =
	"QlpoMTFBWSZTWRA4y24AWB3ZgH4QQAB/4BJlgBBAArgAAOFAAAGTIKAAAMmQJqpR+pT/VUHqAA/UClVADTIaDIdqUo9ih8ZDxCLzIZIdSHtIbIe0hshyQ2EWyGyGyGyGyHUhshsh4hFshshshshsh1IbIbIeIRbIbIaoaoaodSHUh1IdSHUh1IftUgXapAvUh6kPpIfWQ+0h5pUVkhkh4kMkMkPFKiskMkMkPMhkhylRWSGSGSGSGEKWSGSGSGSGSGSGSGSGSGSGSGSGSGKGSHMkMkMkPKhkhkhkhkhihkhxQ5IZIZIZIdKkC7VIF8vvVIF2qQL4KkC7VIF/1SBdqkC/KlKPUhykOSHKQ5SHIRckOCIPUhyQ5IckOSHJDlSrZKoqxQoyQo+IUaIUawUfYKP0FH8xQVkmU1mn7NAnABEk2YB+EEAAf+ASZYAQQAK4AADhQAABkyCgAADJkCaqUn+qb1UTQAD9QKVUANMhoMh3JSjqkPaQ8Qi9JDJDzIdSGyHUhshyQ2EWyGyGyGyGyHmQ2Q2Q8Qi2Q2Q2Q2Q2Q8yGyGyHiiLVDVDVD29ZD1kOpDqQ6kOpDzIeZD9qkC7VIF85D2kPpIfWQ+0h6UqKyQyQ8SGSGSHilRXMkMkMkMkMUOUqKyQyQyQxQyQpZIZIZIYoZIZIZIZIYoZIZIZIZIYoZIZIZIZIZIZIZIZIZIZIZIckOSGSGSGSHlUgXapAvuqQLtUgWqkC7VIF/1SBdqkC/MlKPeQ5SHJDlIcpDkIuSHEiD3IckOSHJDkhyQ4FWwqirrBRjBR8go0go1Qo+oUfkKP5igrJMprJbh+3kAClAswD8IIAA/8AkywAggATwdAhQoAAAyZBQAABkyBNVKP0qf6qgaANNAUpUaIbSaAY9U/1FJfHSLiLwKryixF1F6ItReiLUXEWiq1FqLUWotRdRai1F4FVqLUWotRai6i1FqLxUq2FsLYWwthdRdRdRdlOUpylP2EoahKG/WUyi9UX1RfZF5lUYixF4RYixF4lUYixFiLyixFyVRiLEWIshYqj+cpKuouououwsRYixFiLIWIsRYixFkLEWIsRYiyFiLEWIsRZCxDFTJTaU2lNpTmiUNQlD6RKGoSh6QlDUJQ6QlDSJQ+yiTeUxKZKYlMSmVBkphJU3kuIuIuIuIuIuSLgpFuhXVCv5Cu6FeEK8oVpCv8XckU4UJAi+XsF";
const RUNS = "QlpoOTFBWSZTWZn3TnwAAALBAIAgMAAACCAAIZpoM00JF1Ti7kinChITPunPgA==";
const EMPTY = "QlpoORdyRThQkAAAAAA=";

function multiText(): string {
	let text = "";
	for (let i = 0; text.length < 250_000; i += 1)
		text += `hobo line ${i % 50}${"z".repeat(i % 10)}\n`;
	return text.slice(0, 250_000);
}

const decode = (base64: string): Buffer =>
	Buffer.concat([...bunzip2(new Uint8Array(Buffer.from(base64, "base64")))]);

const root = mkdtempSync(join(tmpdir(), "hobo-l40-bunzip2-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("bunzip2", () => {
	it("decodes a multi-block stream byte for byte", () => {
		const out = decode(MULTI);
		expect(out.length).toBe(250_000);
		expect(createHash("sha256").update(out).digest("hex")).toBe(
			"8710fdb4949dbf30b34b7a430d439ba2ba20b6aa0a28d83198963a73333a0aff",
		);
		expect(out.toString("latin1")).toBe(multiText());
	});

	it("expands run-length codes and decodes an empty stream", () => {
		expect(decode(RUNS).toString("latin1")).toBe(`${"a".repeat(268)}b`);
		expect(decode(EMPTY).length).toBe(0);
	});

	it("refuses data that is not bzip2, is cut short, or fails its block CRC", () => {
		expect(() => decode(Buffer.from("not bzip2").toString("base64"))).toThrow(
			/bzip2/u,
		);
		const bytes = Buffer.from(MULTI, "base64");
		expect(() =>
			decode(bytes.subarray(0, bytes.length - 40).toString("base64")),
		).toThrow(/bzip2/u);
		const corrupt = Buffer.from(bytes);
		// A byte inside the first block's stored CRC.
		corrupt[11] = (corrupt[11] ?? 0) ^ 0xff;
		expect(() => decode(corrupt.toString("base64"))).toThrow(/CRC/u);
	});
});

describe("extractTarEntries", () => {
	it("writes only runsc and gvisor-bin/* from the tarball, executable", () => {
		const into = mkdtempSync(join(root, "x-"));
		const written = extractTarEntries(
			bunzip2(new Uint8Array(Buffer.from(FIXTURE_TARBALL, "base64"))),
			into,
			tarEntryAllowed,
		);
		expect(written.sort()).toEqual(["gvisor-bin/gvisor_sentry", "runsc"]);
		expect(readdirSync(into).sort()).toEqual(["gvisor-bin", "runsc"]);
		expect(readFileSync(join(into, "runsc"), "utf8")).toContain(
			"runsc version release-20261026.0",
		);
		expect(statSync(join(into, "runsc")).mode & 0o777).toBe(0o755);
		expect(statSync(join(into, "gvisor-bin")).mode & 0o777).toBe(0o755);
	});

	it("allows no path outside runsc and gvisor-bin/, and no traversal", () => {
		expect(tarEntryAllowed("runsc")).toBe(true);
		expect(tarEntryAllowed("./runsc")).toBe(true);
		expect(tarEntryAllowed("gvisor-bin/")).toBe(true);
		expect(tarEntryAllowed("gvisor-bin/gvisor_sentry")).toBe(true);
		for (const name of [
			"containerd-shim-runsc-v1",
			"/runsc",
			"../runsc",
			"gvisor-bin/../runsc",
			"gvisor-bin/a/b",
			"gvisor-bin/..",
			"runsc/x",
		])
			expect(tarEntryAllowed(name), name).toBe(false);
	});
});
