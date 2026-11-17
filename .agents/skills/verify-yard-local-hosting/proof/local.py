#!/usr/bin/env python3
"""Guard obligations for host-approved zero-liability local placement."""
import os
import sys
from z3 import And, Bool, Implies, Not, Solver, sat, unsat
names = ('authority','binding','policy','obligations','evidence','zero','identities','authorities','context','final_context')
flags = {name: Bool(name) for name in names}
started, durable = Bool('started'), Bool('durable')
mutation = os.environ.get('YARD_LOCAL_PROOF_MUTATION','')
premise = And(*[value if mutation != name else True for name,value in flags.items()],
              Implies(started,durable) if mutation != 'generation' else True)
obligations = [(name,value) for name,value in flags.items()] + [('funded generation',Implies(started,durable))]
witness=Solver(); witness.add(premise,started); assert witness.check() == sat, 'vacuous local and funded-generation premise'
failed=False
for label,conclusion in obligations:
 solver=Solver(); solver.add(premise,Not(conclusion)); result=solver.check()
 if result != unsat:
  print(f'FAIL {label}: {result} {solver.model() if result == sat else solver.reason_unknown()}'); failed=True
 else: print(f'PASS {label}: stated Boolean guards imply the property')
print('SCOPE: host policy, proof binding, zero managed liability, catalog hashes and durable funding are trusted predicates; no implementation refinement or external costs are proven')
sys.exit(1 if failed else 0)
