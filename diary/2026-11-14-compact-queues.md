# Compact next-action output (#305)

Applied the merged experiment contract's presentation slice independently of the engine: ten default actions, empty sections and zero omission counters hidden from compact text, generic repeated preamble removed, workflow footer disabled by default. Explicit guide flags/settings remain supported; structured fields and zero metadata remain intact. Nonzero omissions, real findings, freshness and configuration diagnostics remain visible.

Updated rendering/configuration expectations and added a focused empty-output/default-limit regression. CLI/MCP use the same renderer; package smoke checks cover both role queues.
