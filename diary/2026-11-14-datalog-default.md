# Default Datalog next actions (#328)

Applied the separately reviewed owner-adoption contract (#327 / PR #329). The registered engine default is now Datalog, including no-matching-project reads; explicit TypeScript settings remain a rollback. When Datalog is selected and no role is requested, the shared read service uses the implementer presentation and reports the role's default source. Explicit supported roles win. This does not infer agent identity, ownership or authority.

Kept the intentional foreground inspection behavior. Full intake/history and all mutation safeguards retain their existing services. TypeScript-specific regression suites now explicitly select rollback; new default/no-role tests and installed CLI/MCP parity cover adoption. Checks, 838 tests, builds, CLI help and isolated installed-package default/rollback parity pass.
