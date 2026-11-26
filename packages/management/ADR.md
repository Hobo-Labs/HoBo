# ADR — `@hobo/management`

**Status:** Accepted  
**Related:** ADR-0131 (Station occupancy), ADR-0150 (control-plane game UI)

## Decision

Export pure management functions for Station, Rail, Connection, and broker-status
projections so CLI, MCP, and the control API share one event-sourced surface.
No second lifecycle; handlers wrap `@hobo/stations` + `@hobo/identity` only.
