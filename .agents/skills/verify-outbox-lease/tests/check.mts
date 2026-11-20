import { strict as assert } from 'node:assert';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.STORAGE_VERIFY_SOURCE_ROOT ?? path.resolve('packages/storage-sqlite/src');
const { createMemoryNodeSqliteDriver, SqliteJournal } = await import(pathToFileURL(path.join(root,'index.ts')).href);

async function scenario(replacement: {id: string; fence: bigint} | null) {
 let now = Date.parse('2026-07-27T12:00:00.000Z');
 const journal = new SqliteJournal(createMemoryNodeSqliteDriver(), {
  clock: { now: () => new Date(now).toISOString() }, nativePragmas: false,
 });
 try {
  await journal.commit({
   streamId:'s1', events:[{type:'a.A',data:{}}],
   append:{expectedSeq:0,actor:{kind:'system',id:'test'},tenant:'t'},
   effects:[{kind:'outbox',destination:'webhook:fixture',idempotencyKey:'k1',payload:{}}],
  });
  const [old] = journal.claimOutbox({limit:1,leaseId:'lease-a',leaseFence:1n,visibilityTimeoutMs:30000});
  assert.ok(old);
  now += 30001;
  if (!replacement) {
   assert.equal(journal.ackOutbox(old.outboxId,old.leaseId,old.leaseFence,old.deliveryAttempt),true);
   return;
  }
  const [current] = journal.claimOutbox({limit:1,leaseId:replacement.id,leaseFence:replacement.fence,visibilityTimeoutMs:30000});
  assert.ok(current);
  assert.equal(current.deliveryAttempt,old.deliveryAttempt+1);
  assert.equal(journal.ackOutbox(old.outboxId,old.leaseId,old.leaseFence,old.deliveryAttempt),false);
  assert.equal(journal.ackOutbox(current.outboxId,current.leaseId,current.leaseFence,current.deliveryAttempt),true);
 } finally { journal.close(); }
}
await scenario({id:'lease-a',fence:1n});
await scenario({id:'lease-a',fence:2n});
await scenario({id:'lease-b',fence:1n});
await scenario(null);
console.log('PASS: delivery attempts fence stale outbox receipts');
