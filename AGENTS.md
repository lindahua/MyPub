# Agent guidance

## Design and requirements

Read [DESIGN.md](DESIGN.md) and [SCHEMAS.md](SCHEMAS.md) before developing this project. Follow DESIGN.md for architecture, workflows, and implementation scope. Follow SCHEMAS.md as the authoritative specification of JSON file formats, field semantics, and catalog-wide schema constraints.

Requirements will evolve. Follow the user's latest explicit instructions when they change the design, and update DESIGN.md and SCHEMAS.md as applicable. Add lasting agent guidance to this file as needed. Keep detailed product requirements in DESIGN.md and format requirements in SCHEMAS.md rather than duplicating them here.

## Development

- Implement the TypeScript core, CLI, and Electron viewer described in DESIGN.md. The user approved desktop implementation after reviewing docs/ELECTRON_DESIGN_DRAFT.md; preserve its light theme, year/venue navigator, and inline expandable details. Editing/review/sync UI remains separate scope.
- The codebase has never been used in production and no v1 catalogs exist. Implement schema version 2 directly; do not add a v1 migration or compatibility layer. This does not change the separate PubMan2 migration scope.
- Name the CLI executable `mypub`, as specified in DESIGN.md.
- Keep changes focused on the requested task and consistent with the design. Resolve routine implementation details using reasonable judgment.
- Keep one-time PubMan2 migration plans, scripts, tests, and migration-only dependencies under `migrate_pubman/`. Do not introduce PubMan2-specific code into the regular application or CLI; general product functionality remains in the normal codebase.
- Preserve existing publication data and user changes.
- Validate changes with appropriate checks, using DESIGN.md's acceptance criteria where relevant.
- Keep documentation consistent with implemented behavior, and clearly distinguish completed functionality from planned functionality.

The design's statements about implementation not having started describe its initial drafting status; they do not prevent development when the user requests it.
