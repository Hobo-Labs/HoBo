#!/usr/bin/env python3
"""Boolean abstraction over arbitrarily many resources and two host kinds."""
import os
import sys
from z3 import And, Bool, Implies, Not, Or, Solver, sat, unsat

has_oci_resource, has_wasm_resource, declared_oci, declared_wasm, http = (
    Bool(name) for name in ('has_oci_resource', 'has_wasm_resource', 'declared_oci', 'declared_wasm', 'http')
)
mutation = os.environ.get('HOBO_BINDLE_RUNTIME_MUTATION', '')
oci = Or(has_oci_resource if mutation != 'drop_oci' else False,
         declared_oci if mutation != 'drop_declared' else False,
         http if mutation == 'invent_oci' else False)
wasm0 = Or(has_wasm_resource if mutation != 'drop_wasm' else False,
           declared_wasm if mutation != 'drop_declared' else False,
           http if mutation == 'invent_wasm' else False)
wasm = And(wasm0, Not(oci)) if mutation == 'drop_mixed' else wasm0
obligations = [
    ('OCI dependencies survive', Implies(has_oci_resource, oci)),
    ('Wasm dependencies survive', Implies(has_wasm_resource, wasm)),
    ('declared OCI survives', Implies(declared_oci, oci)),
    ('declared Wasm survives', Implies(declared_wasm, wasm)),
    ('ordinary HTTP adds no OCI requirement', Implies(And(Not(has_oci_resource), Not(declared_oci)), Not(oci))),
    ('ordinary HTTP adds no Wasm requirement', Implies(And(Not(has_wasm_resource), Not(declared_wasm)), Not(wasm))),
]
witness = Solver(); witness.add(oci, wasm, has_oci_resource, has_wasm_resource)
assert witness.check() == sat or mutation == 'drop_mixed', 'no mixed-runtime success witness'
failed = False
for label, obligation in obligations:
    solver = Solver(); solver.add(Not(obligation)); result = solver.check()
    if result == unsat: print(f'PASS {label}')
    else:
        print(f'FAIL {label}: {result} {solver.model() if result == sat else solver.reason_unknown()}')
        failed = True
print('SCOPE: existential facts summarize an unbounded number of resources; collection and TypeScript refinement are assumptions')
sys.exit(1 if failed else 0)
