"""Abstract quote eligibility and dispatch gate for arbitrary boolean inputs."""
import os
from z3 import And, Bool, Not, Or, Solver, sat, unsat
complete, partial, allow, present = [Bool(s) for s in ('complete','partial','allow','present')]
mutation=os.environ.get('PRICING_ELIGIBILITY_PROOF_MUTATION')
valid=Or(complete,partial)
quoted=And(valid,Or(complete,allow))
eligible=True if mutation == 'partial-eligible' else complete
selected=And(quoted, eligible, True if mutation == 'ignore-missing' else present)
witness=Solver();witness.add(complete,Not(partial),present,selected)
if witness.check()!=sat: raise SystemExit('eligibility premises have no witness')
proof=Solver();proof.add(Not(And(complete,partial)),selected,Or(Not(complete),Not(present)))
if proof.check()!=unsat:
 print('FAIL: incomplete state or missing metadata can be selected:',proof.model())
 raise SystemExit(1)
print('PASS: selection requires complete state and present eligibility')
