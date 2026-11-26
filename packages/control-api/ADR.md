# ADR — `@hobo/control-api`

**Status:** Accepted  
**Related:** ADR-0150, ADR-0111, ADR-0131

Thin local HTTP+SSE adapter. 1:1 with management ops. No second lifecycle.
Auth hooks accept agent-principal headers; default local mode is open like `hobo dev`.
