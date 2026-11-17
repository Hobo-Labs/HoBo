#!/usr/bin/env python3
"""Guard obligations for quote-backed Yard admission and retained holds."""
import os
import sys
from z3 import And, Bool, Implies, Not, Solver, sat, unsat
names=('selection','gate_quote','gate_context','hold_quote','hold_context','fresh','final_context')
flags={name:Bool(name) for name in names}
committed,held=Bool('committed'),Bool('held')
mutation=os.environ.get('YARD_FUNDED_PROOF_MUTATION','')
premise=And(*[flag if mutation != name else True for name,flag in flags.items()],
            Implies(committed,held) if mutation != 'hold' else True)
obligations=[(name,flag) for name,flag in flags.items()]+[('retained hold',Implies(committed,held))]
witness=Solver();witness.add(premise,committed);assert witness.check()==sat,'vacuous committed-hold premise'
failed=False
for label,conclusion in obligations:
 solver=Solver();solver.add(premise,Not(conclusion));result=solver.check()
 if result != unsat:
  print(f'FAIL {label}: {result} {solver.model() if result == sat else solver.reason_unknown()}');failed=True
 else: print(f'PASS {label}: the stated guard implies the property')
print('SCOPE: assumes trusted quote and policy evidence, atomic durable reservation and correct context snapshots; does not prove TypeScript refinement or external billing')
sys.exit(1 if failed else 0)
