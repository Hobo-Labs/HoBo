"""Check Yard budget claim and uncertainty guards against real broker tests."""
from pathlib import Path
import os, re, shutil, subprocess, tempfile
repo=Path(os.environ.get('BROKER_YARD_FUNDED_VERIFY_REPO') or Path(__file__).resolve().parents[4])
base=Path(tempfile.mkdtemp(prefix='hobo-yard-budget-claim-mutants-')); scratch=base/'broker'
shutil.copytree(repo/'packages/broker',scratch,ignore=shutil.ignore_patterns('node_modules','dist','.turbo','coverage'))
(scratch/'node_modules').symlink_to(repo/'packages/broker/node_modules',target_is_directory=True)
(scratch/'tsconfig.json').unlink()
config=Path(__file__).resolve().parents[1]/'models/vitest.config.mts'
source=scratch/'src/yard-placement/deploy.ts';original=source.read_text()
def replace(s,a,b,count=1):
 if s.count(a)!=count:raise RuntimeError(f'expected {count} instances of {a!r}, got {s.count(a)}')
 return s.replace(a,b)
def no_boundary(s):
 s=replace(s,'budgetClaimCurrent() &&','true &&')
 return replace(s,'budgetClaimCurrent();','true;')
def no_persisted_claim(s):
 s=replace(s,'!budgetClaimMatches(financial.authority.lookup(reservationId)) ||','false ||')
 return replace(s,'budgetClaimMatches(\n\t\t\t\t\t\t\tbudgetLookup.call(budgetAuthority, reservationId),\n\t\t\t\t\t\t) &&','true &&')
def no_execution(s):
 s,n=re.subn(r'\(!requireExecution \|\|\s*reservation\.executionDigest ===\s*budgetClaimBinding\.executionDigest\)', 'true', s, count=1)
 if n!=1:raise RuntimeError('execution binding guard not found')
 return s
cases=[
 ('claim-attempt',lambda s:replace(s,'budgetExecutionClaimAttempted = true;','budgetExecutionClaimAttempted = false;'),'generation-budget-claim-commits-then-fails'),
 ('claim-report',lambda s:replace(s,'budgetExecutionClaimAttempted && !budgetExecutionClaimed','false'),'generation-budget-claim-fails'),
 ('uncertain-return',lambda s:replace(s,'matches(marked) &&','true &&'),'generation-budget-claim-uncertain-wrong-binding'),
 ('uncertain-stored',lambda s:replace(s,'matches(stored) &&','true &&'),'generation-budget-claim-uncertain-not-stored'),
 ('claim-return',lambda s:replace(s,'!budgetClaimMatches(claimed) ||','false ||'),'generation-budget-fence-wrong-binding'),
 ('claim-persisted',no_persisted_claim,'generation-budget-fence-not-stored'),
 ('claim-boundary',no_boundary,'generation-budget-fence-changed-before-provider'),
 ('claim-quote',lambda s:replace(s,'reservation.quoteId === budgetClaimBinding.quoteId &&','true &&'),'generation-budget-fence-wrong-quote'),
 ('claim-quote-digest',lambda s:replace(s,'reservation.quoteDigest === budgetClaimBinding.quoteDigest &&','true &&'),'generation-budget-fence-wrong-digest'),
 ('claim-amount',lambda s:replace(s,'reservation.reservedMicros === budgetClaimBinding.reservedMicros &&','true &&'),'generation-budget-fence-wrong-amount'),
 ('claim-identity',lambda s:replace(s,'budgetIdentityKey(reservation.identity) ===\n\t\t\t\t\t\t\tbudgetClaimBinding.identityKey &&','true &&'),'generation-budget-fence-wrong-identity'),
 ('claim-execution',no_execution,'generation-budget-fence-wrong-execution'),
 ('hold-return',lambda s:replace(s,'!budgetClaimMatches(budgetReservation, false) ||','false ||'),'generation-budget-reserve-wrong-binding'),
 ('hold-stored',lambda s:replace(s,'!budgetClaimMatches(previous, false)','false'),'generation-budget-hold-wrong-binding'),
]
def run(pattern):
 return subprocess.run(['node',str(repo/'node_modules/vitest/vitest.mjs'),'run','test/yard-event-store-folds.test.ts','--root',str(scratch),'--config',str(config),'--maxWorkers=1','--no-file-parallelism','-t',pattern],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=180)
try:
 for name,mutate,pattern in cases:
  control=run(pattern)
  if control.returncode or 'Test Files  1 passed' not in control.stdout:raise RuntimeError(f'{name} control failed:\n{control.stdout[-4000:]}')
  print('Control passed:',name,flush=True)
  source.write_text(mutate(original));result=run(pattern)
  if result.returncode==0 or 'FAIL  test/yard-event-store-folds.test.ts >' not in result.stdout or 'AssertionError' not in result.stdout or 'Failed Suites' in result.stdout:raise RuntimeError(f'{name} expected assertion missing:\n{result.stdout[-4000:]}')
  print('Expected real-code failure:',name,flush=True);source.write_text(original)
finally:shutil.rmtree(base)
