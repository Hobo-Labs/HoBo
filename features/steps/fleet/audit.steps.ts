/**
 * Steps for features/fleet/audit.feature (§6.14): the authority checkpoints
 * its audit chain, the witness co-signs, and an auditor reads entries and
 * witnessed checkpoints through the authority and verifies them against the
 * pinned trust record; one altered entry breaks verification.
 */
import assert from "node:assert/strict";
import { Then, When } from "@cucumber/cucumber";
import {
	type AuditEntry,
	AuditCheckpointSchema,
	AuditEntrySchema,
	create,
	fromBinary,
	until,
	verifyAuditChain,
} from "../../../packages/fleet-authority/acceptance/index.js";
import { world } from "./state.js";

let read: { entries: AuditEntry[]; checkpoints: Parameters<typeof verifyAuditChain>[1] } | undefined;

async function witnessedCount(): Promise<number> {
	const w = world();
	const { caller } = await w.person("auditor");
	const answered = await w.authority.auditCheckpoints({ fromSequence: 0 }, caller);
	return answered.ok ? answered.value.checkpoints.length : 0;
}

When("the authority checkpoints its audit chain and the witness co-signs it", async () => {
	const w = world();
	await w.runtime.tickOnce();
	w.clock.advance(61_000);
	// This tick signs the checkpoint and journals it; the next one appends that journal event as the
	// entry the witness recomputes the chain through before it co-signs.
	await w.runtime.tickOnce();
	await w.runtime.tickOnce();
	await until(async () => (await witnessedCount()) > 0, 20_000, "a witnessed checkpoint");
});

Then("the auditor reads the entries and witnessed checkpoints from the authority", async () => {
	const w = world();
	const { caller } = await w.person("auditor");
	const checkpoints = await w.authority.auditCheckpoints({ fromSequence: 0 }, caller);
	assert.ok(checkpoints.ok, checkpoints.ok ? "" : checkpoints.error.message);
	const last = checkpoints.value.checkpoints.at(-1)?.authority?.payload;
	assert.ok(last !== undefined);
	const through = fromBinary(AuditCheckpointSchema, last).sequence;
	assert.ok(through > 0, "the checkpoint covers no entry");
	const entries = await w.authority.auditEntries({ from: 1, to: through }, caller);
	assert.ok(entries.ok, entries.ok ? "" : entries.error.message);
	assert.equal(entries.value.entries.length, through);
	read = { entries: [...entries.value.entries], checkpoints: checkpoints.value.checkpoints };
	const { caller: developer } = await w.person("dev");
	const forbidden = await w.authority.auditEntries({ from: 1, to: through }, developer);
	assert.equal(forbidden.ok ? "ok" : forbidden.error.code, "forbidden");
});

Then("the chain verifies against the pinned trust record", () => {
	assert.ok(read !== undefined);
	const verified = verifyAuditChain(read.entries, read.checkpoints, world().trust);
	assert.ok(verified.ok, verified.ok ? "" : verified.error.message);
	assert.equal(verified.value.entries, read.entries.length);
});

Then("the chain fails to verify once any one entry is altered", () => {
	assert.ok(read !== undefined);
	const { entries, checkpoints } = read;
	for (let index = 0; index < entries.length; index += 1) {
		const altered = entries.map((entry, at) =>
			at === index ? create(AuditEntrySchema, { ...entry, actor: `${entry.actor}-altered` }) : entry,
		);
		assert.equal(verifyAuditChain(altered, checkpoints, world().trust).ok, false, `altering entry ${index + 1} went unnoticed`);
		const removed = entries.filter((_, at) => at !== index);
		assert.equal(verifyAuditChain(removed, checkpoints, world().trust).ok, false, `removing entry ${index + 1} went unnoticed`);
	}
});
