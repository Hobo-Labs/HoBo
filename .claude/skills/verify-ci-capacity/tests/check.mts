import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.CI_VERIFY_SOURCE_ROOT ?? path.resolve('packages/ci/src');
const {SqliteStrictFleetStore}=await import(pathToFileURL(path.join(root,'fleet-v2/sqlite-strict-store.ts')).href);
const p=await import(pathToFileURL(path.join(root,'fleet-v2/parse.ts')).href);
const parse=(fn:any, x:any)=>fn(JSON.stringify(x));
const now='2026-11-03T00:00:00Z'; const hashes={policy:'a'.repeat(64),offer:'b'.repeat(64),quote:'c'.repeat(64)};
const store=new SqliteStrictFleetStore(':memory:');
try {
 await store.initialize();
 await store.createIncarnation(parse(p.parseControllerIncarnation,{id:'incarnation-1',createdAt:now,reason:'bootstrap'}));
 await store.putExecutionProfile(parse(p.parseExecutionProfile,{id:'linux',os:'linux',architecture:'x64',isolation:'trusted-process',lifecycle:'persistent-capacity',guarantee:'start-fenced'}));
 await store.putOfferAdmission(parse(p.parseOfferAdmission,{offerId:'offer',accountId:'account',observationHash:hashes.offer,policyRevision:1,state:'active'}));
 await store.putCapacityGroup(parse(p.parseCapacityGroup,{id:'capacity',accountId:'account',approvedUnits:2,reservedUnits:0,seq:0,state:'active'}));
 function input(jobId:string) {
  const key={githubJob:{kind:'github-job',accountId:'account',engineId:'gh-actions',installationId:'10',repositoryId:'101',runId:'900',jobId,runAttempt:1}};
  const demandKey=parse(p.parseExecutionKey,key);
  const demand=parse(p.parseCiDemand,{key,state:'observed',firstObservedAt:now,lastObservedAt:now,policyRevision:1,requiredProfileId:'linux',source:'webhook',sourceDeliveryIds:[`webhook-${jobId}`]});
  const bindingSecretHash=createHash('sha256').update(`binding-${jobId}`).digest('hex');
  const slot=parse(p.parseRunnerSlot,{id:`slot-${jobId}`,accountId:'account',offerId:'offer',workerBindingId:`worker-${jobId}`,profileId:'linux',runnerName:`hobo-runner-${jobId}`,state:'reserved',capacityGroupId:'capacity',capacityCostUnits:1,policyHash:hashes.policy,offerObservationHash:hashes.offer,quoteHash:hashes.quote,bindingSecretHash,incarnationId:'incarnation-1',createdAt:now});
  const effect=parse(p.parseEffect,{id:`effect-${jobId}`,subjectType:'runner-slot',subjectId:slot.id,kind:'github.provision-runner',sequence:1,state:'planned',idempotencyKey:`provision-${jobId}`,externalLocator:slot.runnerName,createdAt:now,providerScope:'github:10:101'});
  const outbox=parse(p.parseOutbox,{id:`outbox-${jobId}`,effectId:effect.id,state:'pending',availableAt:now,createdAt:now});
  return {demand,reservation:{demandKey,slot,effect,outbox,expectedCapacitySeq:0,expectedPolicyRevision:1}};
 }
 const first=input('1'); const second=input('2');
 await store.intake(first.demand); await store.intake(second.demand);
 const outcomes=await Promise.allSettled([store.reserveCapacity(first.reservation),store.reserveCapacity(second.reservation)]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1,'a stale capacity revision must not admit a second reservation');
 assert.equal((await store.capacityGroup('capacity')).reservedUnits,1);
 console.log('PASS: stale concurrent capacity admission is refused');
} finally {store.close();}
