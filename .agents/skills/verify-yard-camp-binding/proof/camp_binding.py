#!/usr/bin/env python3
"""Unbounded string obligations for the stated Camp-ID construction rules."""
import os
import sys
from z3 import And, Bool, Concat, Contains, If, Implies, Length, Not, Or, PrefixOf, Solver, String, sat, unsat

yard, requested, env, child = String('yard'), String('requested'), String('env'), String('child')
has_id, has_env = Bool('has_id'), Bool('has_env')
prefix = Concat(yard, '/')
qualified = Contains(requested, '/')
relative_valid = And(Length(requested) > 0, Not(qualified), requested != '.', requested != '..')
qualified_valid = And(requested == Concat(prefix, child), Length(child) > 0,
                      Not(Contains(child, '/')), child != '.', child != '..')
env_valid = Or(Not(has_env), And(Length(env) > 0, Not(Contains(env, '/'))))
mutation = os.environ.get('YARD_CAMP_PROOF_MUTATION', '')
scope_guard = If(qualified, qualified_valid if mutation != 'parent' else True, relative_valid)
environment_guard = env_valid if mutation != 'invalid' else True
premise = And(Length(yard) > 0, environment_guard, Implies(has_id, scope_guard))
generated = Concat(prefix, 'camp:', If(has_env, env, 'dev'))
chosen = If(has_id, If(qualified, requested, Concat(prefix, requested)), generated)
if mutation == 'explicit':
    chosen = generated
if mutation == 'environment':
    chosen = If(has_id, If(qualified, requested, Concat(prefix, requested)), Concat(prefix, 'camp:dev'))
chosen_child = If(has_id, If(qualified, child, requested), Concat('camp:', If(has_env, env, 'dev')))
obligations = [
    ('selected Camp has the Yard prefix', PrefixOf(prefix, chosen)),
    ('selected Camp has the expected child', chosen == Concat(prefix, chosen_child)),
    ('child is nonempty and unnested', And(Length(chosen_child) > 0, Not(Contains(chosen_child, '/')))),
    ('explicit identity is preserved', Implies(has_id, chosen == If(qualified, requested, Concat(prefix, requested)))),
    ('generated identity uses requested environment', Implies(Not(has_id), chosen == generated)),
    ('invalid environment is refused', env_valid),
]
witness = Solver()
witness.add(premise, has_id, qualified, has_env)
if witness.check() != sat:
    raise RuntimeError('vacuous qualified Camp premise')
failed = False
mutant_obligation = {
    'parent': 'selected Camp has the Yard prefix',
    'explicit': 'explicit identity is preserved',
    'environment': 'generated identity uses requested environment',
    'invalid': 'invalid environment is refused',
}.get(mutation)
for label, obligation in obligations:
    if mutant_obligation is not None and label != mutant_obligation:
        continue
    solver = Solver()
    solver.set(timeout=15000)
    solver.add(premise, Not(obligation))
    result = solver.check()
    if result != unsat:
        print(f'FAIL {label}: {result} {solver.model() if str(result) == "sat" else solver.reason_unknown()}')
        failed = True
    else:
        print(f'PASS {label}')
print('SCOPE: string construction under stated input guards; no TypeScript refinement or Camp existence is proven')
sys.exit(1 if failed else 0)
