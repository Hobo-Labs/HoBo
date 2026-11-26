/**
 * Evidence pack: include session recording alongside Playwright/CDP artifacts.
 */
import type { RrwebEvent, SessionRecord } from "./types.js";

export type EvidencePack = Readonly<{
	schemaVersion: "hobo.replay-evidence/v1";
	session: SessionRecord;
	recording: readonly RrwebEvent[];
	screenshots: readonly Readonly<{ name: string; sha256: string }>[];
	assertionLog: readonly string[];
	/** Playwright / CDP companion refs (paths or content hashes). */
	playwrightRefs: readonly string[];
}>;

export function buildEvidencePack(input: {
	readonly session: SessionRecord;
	readonly recording: readonly RrwebEvent[];
	readonly screenshots?: readonly Readonly<{ name: string; sha256: string }>[];
	readonly assertionLog?: readonly string[];
	readonly playwrightRefs?: readonly string[];
}): EvidencePack {
	return Object.freeze({
		schemaVersion: "hobo.replay-evidence/v1",
		session: input.session,
		recording: Object.freeze([...input.recording]),
		screenshots: Object.freeze([...(input.screenshots ?? [])]),
		assertionLog: Object.freeze([
			...(input.assertionLog ?? [
				`session ${input.session.id} status=${input.session.status}`,
				`chunks=${input.session.chunkCount}`,
			]),
		]),
		playwrightRefs: Object.freeze([...(input.playwrightRefs ?? [])]),
	});
}
