"""Abstract execution-fence obligations over arbitrary string tokens.

The proof assumes that both attempts observe the same immutable stored token
and that distinct attempts choose distinct tokens. It does not prove these
assumptions or a refinement from the TypeScript implementation.
"""
from z3 import And, Bool, Implies, Not, Solver, String, sat, unsat

first, retry, owner = (String(name) for name in ("first", "retry", "owner"))
first_reply, retry_reply = String("first_reply"), String("retry_reply")
first_effect, retry_effect = Bool("first_effect"), Bool("retry_effect")
current_protocol = Bool("current_protocol")


def check(name, include_distinct=True, include_store=True, include_reply=True,
          include_protocol=True, property_name="unique", expect=unsat):
    solver = Solver()
    if include_distinct:
        solver.add(first != retry)
    requirements = []
    for token, reply, effect in ((first, first_reply, first_effect),
                                 (retry, retry_reply, retry_effect)):
        clauses = []
        if include_store:
            clauses.append(owner == token)
        if include_reply:
            clauses.append(reply == token)
        if include_protocol:
            clauses.append(current_protocol)
        requirements.append(Implies(effect, And(*clauses)))
    solver.add(*requirements)
    if property_name == "unique":
        property = Not(And(first_effect, retry_effect))
    elif property_name == "reply":
        property = Implies(first_effect, first_reply == first)
    else:
        property = Implies(first_effect, current_protocol)
    solver.add(Not(property))
    result = solver.check()
    if result != expect:
        raise AssertionError(f"{name}: expected {expect}, got {result}")
    print(f"{'Proved' if expect == unsat else 'Expected counterexample'}: {name}")


check("distinct attempts cannot both start")
check("an effect requires its matching acknowledgement", property_name="reply")
check("an effect requires the current protocol", property_name="protocol")
check("token collision", include_distinct=False, expect=sat)
check("missing stored-token guard", include_store=False, expect=sat)
check("missing acknowledgement guard", include_reply=False, property_name="reply", expect=sat)
check("missing protocol guard", include_protocol=False, property_name="protocol", expect=sat)
