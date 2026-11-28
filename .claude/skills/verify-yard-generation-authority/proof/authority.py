#!/usr/bin/env python3
"""Symbolic guard implications for Yard generation authority."""
import os
import sys
from z3 import And, Bool, Const, DeclareSort, Implies, Not, Or, Solver, sat, unsat

Connector = DeclareSort('Connector')
selected, called = Const('selected', Connector), Const('called', Connector)
policy, runtime, connector, effect_current, post_current, held, executed, issued = (Bool(n) for n in ('policy','runtime','connector','effect_current','post_current','held','executed','issued'))
mark_available, uncertain, reported = (Bool(n) for n in ('mark_available','uncertain','reported'))
snapshot_available, resolution_started = Bool('snapshot_available'), Bool('resolution_started')
mutation = os.environ.get('YARD_GENERATION_AUTHORITY_MUTATION', '')
guards = [('policy', policy), ('runtime', runtime), ('connector', connector), ('effect', effect_current), ('hold', held)]
premise = And(
    *[Implies(executed, guard) if mutation != name else True for name, guard in guards],
    Implies(resolution_started, snapshot_available) if mutation != 'snapshot' else True,
    Implies(issued, post_current) if mutation != 'post' else True,
    Implies(executed, called == selected) if mutation != 'pin' else True,
    Implies(And(executed, Not(post_current), mark_available), uncertain) if mutation != 'mark' else True,
    Implies(And(executed, Not(post_current), Not(mark_available)), reported) if mutation != 'report' else True,
)
obligations = [(name, Implies(executed, guard)) for name, guard in guards]
obligations += [('runtime snapshot', Implies(resolution_started, snapshot_available)),
                ('current receipt', Implies(issued, post_current)),
                ('pinned connector', Implies(executed, called == selected)),
                ('reconcile changed authority', Implies(And(executed, Not(post_current)), Or(uncertain, reported)))]
witness = Solver(); witness.add(premise, executed, issued, resolution_started, snapshot_available, policy, runtime, connector, effect_current, post_current, held, called == selected)
assert witness.check() == sat, 'no successful generation witness'
failed = False
for label, obligation in obligations:
    solver = Solver(); solver.add(premise, Not(obligation)); result = solver.check()
    if result == unsat: print(f'PASS {label}')
    else:
        print(f'FAIL {label}: {result} {solver.model() if result == sat else solver.reason_unknown()}')
        failed = True
print('SCOPE: assumes truthful identity and policy snapshots, atomic local comparisons and pinned callable behavior; does not prove TypeScript refinement, remote effects or liveness')
sys.exit(1 if failed else 0)
