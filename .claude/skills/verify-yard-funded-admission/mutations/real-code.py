"""Check real-code guard mutations in an isolated broker package."""
from pathlib import Path
import os
import re, shutil, subprocess, tempfile
repo = Path(__file__).resolve().parents[4]
skill = Path(__file__).resolve().parents[1]
original = repo / 'packages/broker/src/yard-placement/deploy.ts'
scratch_parent = Path(tempfile.mkdtemp(prefix='hobo-yard-funded-mutants-'))
scratch = scratch_parent / 'broker'
shutil.copytree(repo / 'packages/broker', scratch, ignore=shutil.ignore_patterns('node_modules', 'dist', '.turbo', 'coverage'))
(scratch / 'node_modules').symlink_to(repo / 'packages/broker/node_modules', target_is_directory=True)
(scratch / 'tsconfig.json').unlink()
target = scratch / 'src/yard-placement/deploy.ts'
config = skill / 'models/vitest.config.mts'
def replace(s,a,b):
 if s.count(a)!=1:raise Exception(f'expected one {a!r}, found {s.count(a)}')
 return s.replace(a,b)
def first(s,a,b):
 p=s.find(a)
 if p<0:raise Exception(f'not found {a!r}')
 return s[:p]+s[p:].replace(a,b,1)
def selection(s):
 s,n=re.subn(r'const quote = quotes\.find\([\s\S]*?\n\s*\);','const quote = quotes[0];',s)
 if n!=2:raise Exception(f'quote selectors found {n}')
 return s
def freshness(s):
 s=s.replace('validateHostingQuote(quote, context.now());','')
 return s.replace('validateHostingQuote(hostingQuote, hostingBudget.now());','')
def final(s):
 pattern=r'if \(!paidContextCurrent\(\)\)\s*throw new Error\(\s*"hosting context changed (?:before receipt|during receipt freshness check); reconcile reservation",\s*\);'
 s,n=re.subn(pattern,'',s)
 if n!=2:raise Exception(f'final guards found {n}')
 return s
def hold(s):
 pattern=r'throw new Error\(\s*"hosting evidence changed while the hold was created; reconcile reservation",\s*\);'
 s,n=re.subn(pattern,'{ context.authority.release(reservationId, true, "incorrect-release"); throw new Error("incorrect release"); }',s,count=1)
 if n!=1:raise Exception('hold guard not found')
 return s
def claim(s):
 pattern=r'if \(!paidContextCurrent\(\) \|\| !generationAuthorityCurrent\(\)\)\s*throw new Error\(\s*"hosting context changed before generation claim; reconcile reservation",\s*\);'
 found=list(re.finditer(pattern,s))
 if len(found)!=2:raise Exception(f'claim guards found {len(found)}')
 m=found[-1];return s[:m.start()]+s[m.end():]
def work_binding(s):
 pattern=r'if \(quote.workDigest !== workDigest\)\s*throw new Error\(\s*"hosting quote does not bind selected work and generation plan",\s*\);'
 s,n=re.subn(pattern,'',s,count=1)
 if n!=1:raise Exception('work binding guard not found')
 return s
def plan_claim(s):
 pattern=r'if \(!generationAuthorityCurrent\(\)\)\s*throw new Error\(\s*"generation authority changed after quote approval; reconcile reservation",\s*\);'
 s,n=re.subn(pattern,'',s,count=1)
 if n!=1 or s.count(' || !generationAuthorityCurrent()')<2:raise Exception('generation claim guards not found')
 return s.replace(' || !generationAuthorityCurrent()','',2)
def signal(s):
 pattern=r'return rejectAfterGeneration\(\s*"placement",\s*"yard-generation-uncertain",\s*error instanceof Error\s*\? error\.message\s*:\s*"generation signals unavailable",\s*\);'
 s,n=re.subn(pattern,'throw error;',s,count=1)
 if n!=1:raise Exception('signal guard not found')
 return s
cases=[
 ('selection',selection,'yard-funded-quote-race.test.ts','different Yard or provider'),
 ('policy-quote',lambda s:first(s,'toJsonString(HostingQuoteSchema, policyQuote) !== expectedQuote ||',''),'yard-funded-quote-race.test.ts','changed provider while policy'),
 ('quote-id',lambda s:replace(s,'proof.quoteId !== quote.quoteId ||',''),'yard-policy-quote-binding.test.ts','complete quote content'),
 ('quote-digest',lambda s:replace(s,'proof.quoteDigest !== quoteDigest ||',''),'yard-policy-quote-binding.test.ts','complete quote content'),
 ('work-binding',work_binding,'yard-quote-work-binding.test.ts','binds a Yard quote'),
 ('work-after-generation',work_binding,'yard-event-store-folds.test.ts','changed-work-after-generation'),
 ('plan-before-claim',plan_claim,'yard-event-store-folds.test.ts','changed-plan-before-claim'),
 ('source-quote',lambda s:replace(s,'quoteKey(hostingBudget.quotes) === quotesDigest','true'),'yard-funded-quote-race.test.ts','changed source quote while policy'),
 ('policy-authority',lambda s:replace(s,'deps.authorizeHosting === paidAuthority &&','true &&'),'yard-funded-quote-race.test.ts','changed authority while policy'),
 ('budget',lambda s:first(s,'deps.hostingBudget === hostingBudget &&','true &&'),'yard-funded-quote-race.test.ts','changed budget while policy'),
 ('budget-authority',lambda s:replace(s,'hostingBudget.authority === budgetAuthority &&','true &&'),'yard-funded-quote-race.test.ts','changed budget authority while policy'),
 ('reserve-method',lambda s:replace(s,'budgetAuthority?.reserve === budgetReserve &&','true &&'),'yard-funded-quote-race.test.ts','changed reserve method while policy'),
 ('uncertain-method',lambda s:replace(s,'budgetAuthority?.uncertain === budgetUncertain &&','true &&'),'yard-funded-quote-race.test.ts','changed uncertain method while policy'),
 ('persistence',lambda s:replace(s,'budgetAuthority?.persistence === budgetPersistence &&','true &&'),'yard-funded-quote-race.test.ts','changed persistence while policy'),
 ('clock',lambda s:replace(s,'hostingBudget.now === budgetClock &&','true &&'),'yard-funded-quote-race.test.ts','changed clock while policy'),
 ('catalog',lambda s:first(s,'deps.catalog.catalogHash === catalogHash &&','true &&'),'yard-funded-quote-race.test.ts','changed catalog while policy'),
 ('owner',lambda s:first(s,'deps.ownerTenantId === ownerTenant &&','true &&'),'yard-funded-quote-race.test.ts','changed owner while policy'),
 ('reserved-quote',lambda s:replace(s,'toJsonString(HostingQuoteSchema, reservedQuote) !== expectedQuote ||',''),'yard-funded-quote-race.test.ts','retains a new hold and refuses changed reserved quote'),
 ('freshness',freshness,'yard-funded-quote-race.test.ts','retains a new hold and refuses changed expiry'),
 ('final-fence',final,'yard-funded-quote-race.test.ts','after funded admission and before the receipt'),
 ('hold',hold,'yard-funded-quote-race.test.ts','retains a new hold and refuses changed reserved quote'),
 ('lookup',lambda s:replace(s,'throw new Error("hosting budget evidence is unavailable");','return costs;'),'yard-event-store-folds.test.ts','lookup-unavailable'),
 ('mark-uncertain',lambda s:replace(s,'budgetUncertain.call(budgetAuthority, reservationId);','void budgetUncertain;'),'yard-event-store-folds.test.ts','missing-residual'),
 ('report-uncertain',lambda s:s.replace('; uncertain status could not be recorded; reconcile the hold','; reconcile required'),'yard-event-store-folds.test.ts','uncertain-write-failed'),
 ('original-authority',lambda s:replace(s,'budgetUncertain.call(budgetAuthority, reservationId);','deps.hostingBudget?.authority.uncertain(reservationId);'),'yard-event-store-folds.test.ts','context-after-generation'),
 ('claim-fence',claim,'yard-event-store-folds.test.ts','context-before-claim'),
 ('signals',signal,'yard-event-store-folds.test.ts','signals-unavailable'),
]
def run(test, pattern):
 args=['node',str(repo/'node_modules/vitest/vitest.mjs'),'run',f'test/{test}','--root',str(scratch),'--config',str(config),'--maxWorkers=1','--no-file-parallelism','-t',pattern]
 return subprocess.run(args,cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=90)
try:
 control=run('yard-funded-quote-race.test.ts','changed provider while policy')
 if control.returncode != 0 or 'Test Files  1 passed' not in control.stdout:raise Exception(f'unmodified control failed:\n{control.stdout[-2200:]}')
 print('Unmodified control passed',flush=True)
 for name,mutate,test,pattern in cases:
  if os.environ.get('MUTATION_CASE') and os.environ['MUTATION_CASE']!=name:continue
  target.write_text(mutate(original.read_text()))
  r=run(test,pattern)
  if r.returncode==0 or f'FAIL  test/{test} >' not in r.stdout or 'Failed Suites' in r.stdout:raise Exception(f'{name} did not fail the expected running test ({r.returncode}):\n{r.stdout[-2200:]}')
  print(f'Expected real-code failure: {name}',flush=True)
finally:shutil.rmtree(scratch_parent)
