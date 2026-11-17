#!/usr/bin/env python3
"""Symbolic runtime-binding obligations for arbitrary requirement values."""
import os
import sys
from z3 import And, Bool, BoolSort, Const, DeclareSort, Function, Implies, Not, Solver, sat, unsat

Requirements = DeclareSort('Requirements')
Host = DeclareSort('Host')
empty, derived_before, derived_during, derived_after, declared_before, declared_during, declared_after = (
    Const(name, Requirements) for name in ('empty', 'derived_before', 'derived_during', 'derived_after', 'declared_before', 'declared_during', 'declared_after')
)
local_host = Const('local_host', Host)
local_declarations = Function('local_declarations', Requirements, BoolSort())
host_for = Function('host_for', Requirements, Requirements, Host)
authorized, resolved = Bool('authorized'), Bool('resolved')
mutation = os.environ.get('HOBO_LOCAL_RUNTIME_MUTATION', '')
premise = And(
    Implies(authorized, derived_before == empty) if mutation != 'derived' else True,
    Implies(authorized, local_declarations(declared_before)) if mutation != 'declared' else True,
    Implies(authorized, derived_during == derived_before) if mutation != 'derived_during' else True,
    Implies(authorized, declared_during == declared_before) if mutation != 'declared_during' else True,
    Implies(resolved, authorized) if mutation != 'approval' else True,
    Implies(resolved, derived_after == derived_before) if mutation != 'derived_handoff' else True,
    Implies(resolved, declared_after == declared_before) if mutation != 'declared_handoff' else True,
    Implies(local_declarations(declared_before), host_for(empty, declared_before) == local_host) if mutation != 'mapping' else True,
)
obligations = [
    ('local execution host', Implies(resolved, host_for(derived_before, declared_before) == local_host)),
    ('local derived requirements', Implies(resolved, derived_before == empty)),
    ('local declared requirements', Implies(resolved, local_declarations(declared_before))),
    ('derived stable during approval', Implies(resolved, derived_during == derived_before)),
    ('declared stable during approval', Implies(resolved, declared_during == declared_before)),
    ('derived stable at handoff', Implies(resolved, derived_after == derived_before)),
    ('declared stable at handoff', Implies(resolved, declared_after == declared_before)),
]
witness = Solver(); witness.add(premise, authorized, resolved, derived_before == empty, local_declarations(declared_before), derived_during == derived_before, declared_during == declared_before, derived_after == derived_before, declared_after == declared_before)
assert witness.check() == sat, 'no successful local placement witness'
failed = False
for label, obligation in obligations:
    solver = Solver(); solver.add(premise, Not(obligation)); result = solver.check()
    if result == unsat: print(f'PASS {label}')
    else:
        print(f'FAIL {label}: {result} {solver.model() if result == sat else solver.reason_unknown()}')
        failed = True
print('SCOPE: assumes runtime collection, equality and local-host mapping are truthful; does not prove TypeScript refinement or execution after return')
sys.exit(1 if failed else 0)
