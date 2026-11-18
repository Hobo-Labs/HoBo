"""Run the funded-admission skill against isolated broken and restored copies."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import os, shutil, subprocess, tempfile
repo=Path(os.environ.get('BROKER_YARD_FUNDED_VERIFY_REPO') or Path(__file__).resolve().parents[4])
out=Path(tempfile.mkdtemp(prefix='hobo-yard-funded-full-mutants-'))
print('Verification logs:',out,flush=True)
def replace(s,a,b,count=1):
 if s.count(a)!=count:raise RuntimeError(f'expected {count} instances of {a!r}, got {s.count(a)}')
 return s.replace(a,b)
def no_boundary(s):
 s=replace(s,'budgetClaimCurrent() &&','true &&')
 return replace(s,'budgetClaimCurrent();','true;')
def no_persisted_claim(s):
 s=replace(s,'!budgetClaimMatches(financial.authority.lookup(reservationId)) ||','false ||')
 return replace(s,'budgetClaimMatches(\n\t\t\t\t\t\t\tbudgetLookup.call(budgetAuthority, reservationId),\n\t\t\t\t\t\t) &&','true &&')
def policy_quote(s):
 guard='toJsonString(HostingQuoteSchema, policyQuote) !== expectedQuote ||'
 if s.count(guard)!=2:raise RuntimeError('policy quote guard count changed')
 return s.replace(guard,'',1)
cases=[
 ('policy-quote',policy_quote,'yard-funded-quote-race.test.ts'),
 ('claim-attempt',lambda s:replace(s,'budgetExecutionClaimAttempted = true;','budgetExecutionClaimAttempted = false;'),'yard-event-store-folds.test.ts'),
 ('claim-report',lambda s:replace(s,'budgetExecutionClaimAttempted && !budgetExecutionClaimed','false'),'yard-event-store-folds.test.ts'),
 ('uncertain-return',lambda s:replace(s,'matches(marked) &&','true &&'),'yard-event-store-folds.test.ts'),
 ('uncertain-stored',lambda s:replace(s,'matches(stored) &&','true &&'),'yard-event-store-folds.test.ts'),
 ('claim-return',lambda s:replace(s,'!budgetClaimMatches(claimed) ||','false ||'),'yard-event-store-folds.test.ts'),
 ('claim-persisted',no_persisted_claim,'yard-event-store-folds.test.ts'),
 ('claim-boundary',no_boundary,'yard-event-store-folds.test.ts'),
]
def run(name,mutate,expected):
 parent=Path(tempfile.mkdtemp(prefix=name+'-',dir=out));src=repo/'packages/broker';scratch=parent/'broker'
 try:
  shutil.copytree(src,scratch,ignore=shutil.ignore_patterns('node_modules','dist','.turbo','coverage'))
  (scratch/'node_modules').symlink_to(src/'node_modules',target_is_directory=True)
  (scratch/'tsconfig.json').unlink()
  if mutate:
   source=scratch/'src/yard-placement/deploy.ts';source.write_text(mutate(source.read_text()))
  env={**os.environ,'BROKER_YARD_FUNDED_VERIFY_PACKAGE_ROOT':str(scratch)}
  log=out/f'{name}.log'; print('Checking:',name,flush=True)
  with log.open('w') as f:
   result=subprocess.run(['bash','scripts/verify-state-machine.sh','.agents/skills/verify-yard-funded-admission'],cwd=repo,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=600)
  text=log.read_text()
  if expected:
   if result.returncode==0 or f'FAIL  test/{expected} >' not in text or 'AssertionError' not in text or 'Failed Suites' in text or 'Parsing or semantic analysis failed' in text:
    raise RuntimeError(f'{name}: expected running assertion missing; inspect {log}')
   print('Expected assertion:',name,flush=True)
  elif result.returncode:raise RuntimeError(f'{name}: restored verification failed; inspect {log}')
  else:print('Restored verification PASS',flush=True)
 finally:shutil.rmtree(parent)
with ThreadPoolExecutor(max_workers=int(os.environ.get('BROKER_YARD_FUNDED_MUTATION_WORKERS','2'))) as pool:
 futures=[pool.submit(run,*case) for case in cases];failures=[]
 for future in as_completed(futures):
  try:future.result()
  except Exception as e:failures.append(str(e));print('FAIL:',e,flush=True)
 if failures:raise SystemExit('\n'.join(failures))
run('restored',None,None)
