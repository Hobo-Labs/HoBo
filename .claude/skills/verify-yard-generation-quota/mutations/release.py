"""Check quota release and upgrade guards against isolated real broker tests."""
from pathlib import Path
import os, re, shutil, subprocess, tempfile
repo=Path(os.environ.get('BROKER_GENERATION_QUOTA_VERIFY_REPO') or Path(__file__).resolve().parents[4])
base=Path(tempfile.mkdtemp(prefix='hobo-quota-release-mutants-'));scratch=base/'broker'
shutil.copytree(repo/'packages/broker',scratch,ignore=shutil.ignore_patterns('node_modules','dist','.turbo','coverage'))
(scratch/'node_modules').symlink_to(repo/'packages/broker/node_modules',target_is_directory=True)
(scratch/'tsconfig.json').unlink()
config=Path(__file__).resolve().parents[1]/'models/vitest.config.mts'
quota=scratch/'src/yard-placement/generation-quota.ts';deploy=scratch/'src/yard-placement/deploy.ts'
originals={quota:quota.read_text(),deploy:deploy.read_text()}
def replace(s,a,b,count=1):
 if s.count(a)!=count:raise RuntimeError(f'expected {count} instances of {a!r}, got {s.count(a)}')
 return s.replace(a,b)
def last(s,a,b,count=2):
 if s.count(a)!=count:raise RuntimeError(f'expected {count} instances of {a!r}, got {s.count(a)}')
 p=s.rfind(a);return s[:p]+s[p:].replace(a,b,1)
def regex(s,pattern,replacement):
 s,n=re.subn(pattern,replacement,s,count=1)
 if n!=1:raise RuntimeError(f'pattern not found: {pattern}')
 return s
def scope(s):
 return regex(s,r'meta &&\s*\(meta\.scope_id !== options\.scopeId \|\|\s*\(meta\.baseline_hash !== legacyBaselineHash &&\s*meta\.baseline_hash !== baselineHash\)\)','false')
def old_update_guard(s):
 return regex(s,r'CREATE TRIGGER IF NOT EXISTS generation_quota_guard_update BEFORE UPDATE ON generation_quota_claims WHEN NOT EXISTS\(SELECT 1 FROM generation_quota_write_permit WHERE id=1\) BEGIN SELECT RAISE\(ABORT, \'quota execution fencing required\'\); END; ','')
def no_tombstone_evidence(s):
 return regex(s,r'quotaLookupCancellation\.call\(quota, quotaRequest\.idempotencyKey\) !==\s*quotaRequestDigest \|\|','false ||')
def no_cancel_checks(s):
 s=no_tombstone_evidence(s)
 return regex(s,r'quotaLookup\.call\(quota, quotaRequest\.idempotencyKey\) !==\s*undefined \|\|','false ||')
cases=[
 ('cancel-fence',quota,lambda s:replace(s,'if (claim.executionClaimed || claim.status !== "pending")','if (claim.status !== "pending")'),'yard-generation-quota-release.test.ts','retains a claimed slot'),
 ('tombstone',quota,lambda s:replace(s,'if (cancelled)\n','if (false && cancelled)\n'),'yard-generation-quota-release.test.ts','releases only an unclaimed reservation'),
 ('unique-claim',quota,lambda s:replace(s,'return Object.freeze({ kind: "existing" as const, claim });','return Object.freeze({ kind: "claimed" as const, claim });'),'yard-generation-quota-release.test.ts','retains a claimed slot'),
 ('cancel-identity',quota,lambda s:last(s,'if (!claim || !matchesRequest(claim, request))','if (!claim)'),'yard-generation-quota-release.test.ts','releases only an unclaimed reservation'),
 ('scope',quota,scope,'yard-generation-quota-release.test.ts','pre-upgrade pending reservation'),
 ('legacy-fence',quota,lambda s:replace(s,'INSERT OR IGNORE INTO generation_quota_execution(idempotency_key) SELECT idempotency_key FROM generation_quota_claims','SELECT 1'),'yard-generation-quota-release.test.ts','pre-upgrade pending reservation'),
 ('old-writer',quota,old_update_guard,'yard-generation-quota-release.test.ts','pre-upgrade pending reservation'),
 ('stored-execution',deploy,lambda s:replace(s,'(!quotaExecutionClaimed || claim?.executionClaimed === true) &&','true &&'),'yard-event-store-folds.test.ts','generation-quota-fence-not-stored'),
 ('stored-tombstone',deploy,no_tombstone_evidence,'yard-event-store-folds.test.ts','generation-quota-cancel-evidence-unavailable'),
 ('cancel-evidence',deploy,no_cancel_checks,'yard-event-store-folds.test.ts','generation-quota-cancel-not-stored'),
 ('automatic-cancel',deploy,lambda s:replace(s,'quotaCancelUnclaimed.call(quota, quotaRequest)','(() => { throw new Error("cancel disabled"); })()'),'yard-event-store-folds.test.ts','generation-budget-fails-after-quota'),
 ('budget-ack',deploy,lambda s:replace(s,'if (generationPlanHash) generationBudgetReserveAttempted = true;','void generationPlanHash;'),'yard-event-store-folds.test.ts','generation-budget-commits-then-fails'),
 ('quota-ack',deploy,lambda s:replace(s,'quotaReservationOutcomeUnknown = true;','quotaReservationOutcomeUnknown = false;'),'yard-event-store-folds.test.ts','generation-quota-reserve-commits-then-fails'),
]
def run(test,pattern):
 return subprocess.run(['node',str(repo/'node_modules/vitest/vitest.mjs'),'run',f'test/{test}','--root',str(scratch),'--config',str(config),'--maxWorkers=1','--no-file-parallelism','-t',pattern],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=180)
try:
 for name,target,mutate,test,pattern in cases:
  control=run(test,pattern)
  if control.returncode!=0 or 'Test Files  1 passed' not in control.stdout:raise RuntimeError(f'{name} control failed:\n{control.stdout[-4000:]}')
  print('Control passed:',name,flush=True)
  target.write_text(mutate(originals[target]));result=run(test,pattern)
  if result.returncode==0 or f'FAIL  test/{test} >' not in result.stdout or 'AssertionError' not in result.stdout or 'Failed Suites' in result.stdout:raise RuntimeError(f'{name} expected assertion missing:\n{result.stdout[-4000:]}')
  print('Expected real-code failure:',name,flush=True);target.write_text(originals[target])
finally:shutil.rmtree(base)
