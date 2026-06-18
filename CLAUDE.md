<!-- claude-skills-mcp-force -->
## MCP REQUIRED

Use ONLY MCP filesystem tools for file operations.

❌ Do NOT use: `Read`, `Write`, `Edit`, `Glob`, `Grep`, or CLI MCP (`run_command`, `list_available_clis`)

✅ Use:
- `mcp__filesystem__read_file`
- `mcp__filesystem__write_file`
- `mcp__filesystem__edit_file`
- `mcp__filesystem__list_directory`
- `mcp__filesystem__search_files`
<!-- /claude-skills-mcp-force -->