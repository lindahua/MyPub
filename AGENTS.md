# Agent guidance

## Design and requirements

Read [DESIGN.md](DESIGN.md) before developing this project. Follow it as the primary reference for architecture, data structures, workflows, and implementation scope.

Requirements will evolve. Follow the user's latest explicit instructions when they change the design, and update DESIGN.md to reflect agreed changes. Add lasting agent guidance to this file as needed. Keep detailed product requirements in DESIGN.md rather than duplicating them here.

## Development

- Implement the current phase described in DESIGN.md: the TypeScript core and CLI. Electron UI development belongs to a later phase.
- Keep changes focused on the requested task and consistent with the design. Resolve routine implementation details using reasonable judgment.
- Preserve existing publication data and user changes.
- Validate changes with appropriate checks, using DESIGN.md's acceptance criteria where relevant.
- Keep documentation consistent with implemented behavior, and clearly distinguish completed functionality from planned functionality.

The design's statements about implementation not having started describe its initial drafting status; they do not prevent development when the user requests it.
