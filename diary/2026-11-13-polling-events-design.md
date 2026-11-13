# Optional polling/event design

Defined #32's opt-in process-local watcher, 30-minute default, successful-baseline transitions, bounded nondestructive event history, cursor gaps and deterministic event kinds. Scoped one read-only event tool separately from baseline MCP and kept delivery/wake-up/shared-backend work independent. No live watcher, configuration or production code changed.
