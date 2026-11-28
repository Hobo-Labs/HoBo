import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-yard-policy-cue-'));
try {
  copyFileSync(path.resolve('packages/broker/data-models/budget.cue'),path.join(scratch,'budget.cue'));
  copyFileSync(path.resolve('packages/broker/data-models/budget_fence_settlement_guard.cue'),path.join(scratch,'budget_fence_settlement_guard.cue'));
  const body=(field: string) => `package data_models\ninput: #HostingPolicyProof & {requestDigest: "r", quoteId: "q", identity: {tenantId: "t", budgetId: "b", periodId: "p", policyRevision: "r"}, policyHash: "policy", effect: "allow", evidenceRef: "evidence", obligationsSatisfied: true ${field}}\n`;
  for(const [name,field,valid] of [['valid',`, quoteDigest: "${'a'.repeat(64)}"`,true],['missing','',false],['malformed',', quoteDigest: "not-a-digest"',false]] as const){
    writeFileSync(path.join(scratch,'fixture.cue'),body(field));
    const result=spawnSync(process.env.HOBO_CUE_BIN ?? 'cue',['vet','-c','budget.cue','budget_fence_settlement_guard.cue','fixture.cue'],{cwd:scratch,encoding:'utf8'});
    if(result.error) throw result.error;
    if((result.status === 0) !== valid) throw new Error(`CUE ${name} had unexpected result: ${result.stdout}\n${result.stderr}`);
    process.stdout.write(`CUE ${name}: ${valid ? 'accepted' : 'refused'}\n`);
  }
  const quoteBody=(field: string) => `package data_models\ninput: #HostingQuote & {quoteId: "q", yardId: "y", providerId: "p", ownerTenantId: "t", currency: "USD", totalMicros: 1, observedAt: "now", validUntil: "later", requestDigest: "r", components: [{name: "execution", costMicros: 1}] ${field}}\n`;
  for(const [name,field,valid] of [['bound',`, workDigest: "sha256:${'a'.repeat(64)}"`,true],['generic-unbound','',true],['malformed',', workDigest: "bad"',false]] as const){
    writeFileSync(path.join(scratch,'fixture.cue'),quoteBody(field));
    const result=spawnSync(process.env.HOBO_CUE_BIN ?? 'cue',['vet','-c','budget.cue','budget_fence_settlement_guard.cue','fixture.cue'],{cwd:scratch,encoding:'utf8'});
    if(result.error) throw result.error;
    if((result.status === 0) !== valid) throw new Error(`CUE quote ${name} had unexpected result: ${result.stdout}\n${result.stderr}`);
    process.stdout.write(`CUE quote ${name}: ${valid ? 'accepted' : 'refused'}\n`);
  }
} finally { rmSync(scratch,{recursive:true,force:true}); }
