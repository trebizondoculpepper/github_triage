# Recent Node runtime policy

Owner removed old-Node compatibility as a constraint. Selected Node 26+ from the current official LTS announcement and updated architecture/migration/MCP guidance. #108 tracks engine/build/CI/user-requirement alignment without blocking the urgent TypeScript port or requiring runner/bundle redesign. npm/npx uses the available runtime; no global Node, workflow, engine field or production source was changed in this docs task.
