from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import os, re, shutil, subprocess, tempfile
repo=Path(os.environ.get('BROKER_GENERATION_QUOTA_VERIFY_REPO') or Path(__file__).resolve().parents[4])
out=Path(tempfile.mkdtemp(prefix='hobo-quota-full-mutants-'))
print('Verification logs:',out,flush=True)
def repl(a,b,count=1):
 def apply(s):
  if s.count(a)!=count: raise RuntimeError(f'expected {count} of {a!r}, got {s.count(a)}')
  return s.replace(a,b)
 return apply
def combine(*funcs):
 def apply(s):
  for f in funcs: s=f(s)
  return s
 return apply
def regex(pattern):
 def apply(s):
  s,n=re.subn(pattern,'false ||',s,count=1)
  if n!=1: raise RuntimeError(f'pattern not found: {pattern}')
  return s
 return apply
def remove_old_writer(s):
 s,n=re.subn(r"CREATE TRIGGER IF NOT EXISTS generation_quota_guard_update BEFORE UPDATE ON generation_quota_claims WHEN NOT EXISTS\(SELECT 1 FROM generation_quota_write_permit WHERE id=1\) BEGIN SELECT RAISE\(ABORT, 'quota execution fencing required'\); END; ",'',s,count=1)
 if n!=1: raise RuntimeError('old writer trigger not found')
 return s
q='src/yard-placement/generation-quota.ts'; d='src/yard-placement/deploy.ts'
cases=[
 ('concurrency',q,repl('if (concurrent >= request.maxConcurrentGenerations)','if (false)'),'yard-generation-quota.test.ts'),
 ('tenant',q,repl('if (tenant >= request.maxYardsPerTenant)','if (false)'),'yard-generation-quota.test.ts'),
 ('ready',q,repl('const verifyReady = options.verifyReady;','const verifyReady = () => true;'),'yard-generation-quota.test.ts'),
 ('durable',d,combine(repl('if (!quota || quota.persistence !== "durable-sqlite")','if (!quota)'),repl('quota.persistence === "durable-sqlite" &&','true &&')),'yard-event-store-folds.test.ts'),
 ('claim',d,repl('!quotaClaimMatches(reservation.claim) ||','false ||'),'yard-event-store-folds.test.ts'),
 ('stored-ready',d,combine(repl('storedReady?.status !== "ready" ||','false ||'),repl('storedReady.readyEvidenceRef !== ready.readyEvidenceRef ||','false ||')),'yard-event-store-folds.test.ts'),
 ('order',d,repl('\t\t\tawait admitHosting(\n\t\t\t\tgenDecision.plan.expectedYardId,','\t\t\treserveGenerationQuota();\n\t\t\tawait admitHosting(\n\t\t\t\tgenDecision.plan.expectedYardId,'),'yard-event-store-folds.test.ts'),
 ('provider-boundary',d,combine(repl('if (generationAuthorityCurrent?.() !== true)','if (false)'),repl('authorizePlan: (plan) =>\n\t\t\t\tgenerationAuthorityCurrent?.() === true &&\n\t\t\t\tcontentHashOf(plan) === contentHashOf(genDecision.plan) &&\n\t\t\t\tgenerationAuthorityCurrent?.() === true,','authorizePlan: (plan) => contentHashOf(plan) === contentHashOf(genDecision.plan),')),'yard-event-store-folds.test.ts'),
 ('cancel-fence',q,repl('if (claim.executionClaimed || claim.status !== "pending")','if (claim.status !== "pending")'),'yard-generation-quota-release.test.ts'),
 ('tombstone',q,repl('if (cancelled)\n','if (false && cancelled)\n'),'yard-generation-quota-release.test.ts'),
 ('unique-claim',q,repl('return Object.freeze({ kind: "existing" as const, claim });','return Object.freeze({ kind: "claimed" as const, claim });'),'yard-generation-quota-release.test.ts'),
 ('legacy-fence',q,repl('INSERT OR IGNORE INTO generation_quota_execution(idempotency_key) SELECT idempotency_key FROM generation_quota_claims','SELECT 1'),'yard-generation-quota-release.test.ts'),
 ('old-writer',q,remove_old_writer,'yard-generation-quota-release.test.ts'),
 ('stored-execution',d,repl('(!quotaExecutionClaimed || claim?.executionClaimed === true) &&','true &&'),'yard-event-store-folds.test.ts'),
 ('stored-tombstone',d,regex(r'quotaLookupCancellation\.call\(quota, quotaRequest\.idempotencyKey\) !==\s*quotaRequestDigest \|\|'),'yard-event-store-folds.test.ts'),
 ('budget-ack',d,repl('if (generationPlanHash) generationBudgetReserveAttempted = true;','void generationPlanHash;'),'yard-event-store-folds.test.ts'),
 ('quota-ack',d,repl('quotaReservationOutcomeUnknown = true;','quotaReservationOutcomeUnknown = false;'),'yard-event-store-folds.test.ts'),
]
def check(case):
 name,filename,mutate,test=case
 parent=Path(tempfile.mkdtemp(prefix=f'{name}-',dir=out)); src=repo/'packages/broker'; scratch=parent/'broker'
 try:
  shutil.copytree(src,scratch,ignore=shutil.ignore_patterns('node_modules','dist','.turbo','coverage'))
  (scratch/'node_modules').symlink_to(src/'node_modules',target_is_directory=True)
  (scratch/'tsconfig.json').unlink()
  target=scratch/filename; target.write_text(mutate(target.read_text()))
  env={**os.environ,'BROKER_GENERATION_QUOTA_VERIFY_PACKAGE_ROOT':str(scratch)}
  log=out/f'{name}.log'; print('Checking broken:',name,flush=True)
  with log.open('w') as f:
   result=subprocess.run(['bash','scripts/verify-state-machine.sh','.agents/skills/verify-yard-generation-quota'],cwd=repo,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=600)
  text=log.read_text()
  if result.returncode==0 or f'FAIL  test/{test} >' not in text or 'AssertionError' not in text or 'Failed Suites' in text or 'Parsing or semantic analysis failed' in text:
   raise RuntimeError(f'{name}: expected assertion missing; inspect {log}')
  print('Expected assertion:',name,flush=True)
 finally: shutil.rmtree(parent)
with ThreadPoolExecutor(max_workers=int(os.environ.get('BROKER_GENERATION_QUOTA_MUTATION_WORKERS','2'))) as pool:
 futures=[pool.submit(check,c) for c in cases]; failures=[]
 for future in as_completed(futures):
  try:future.result()
  except Exception as e:failures.append(str(e));print('FAIL:',e,flush=True)
 if failures:raise SystemExit('\n'.join(failures))

parent=Path(tempfile.mkdtemp(prefix='restored-',dir=out)); src=repo/'packages/broker'; scratch=parent/'broker'
try:
 shutil.copytree(src,scratch,ignore=shutil.ignore_patterns('node_modules','dist','.turbo','coverage'))
 (scratch/'node_modules').symlink_to(src/'node_modules',target_is_directory=True)
 (scratch/'tsconfig.json').unlink()
 env={**os.environ,'BROKER_GENERATION_QUOTA_VERIFY_PACKAGE_ROOT':str(scratch)}
 log=out/'restored.log'
 print('Checking restored implementation',flush=True)
 with log.open('w') as f:
  result=subprocess.run(['bash','scripts/verify-state-machine.sh','.agents/skills/verify-yard-generation-quota'],cwd=repo,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=600)
 if result.returncode: raise RuntimeError(f'restored verification failed; inspect {log}')
 print('Restored verification PASS',flush=True)
finally: shutil.rmtree(parent)
