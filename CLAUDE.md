<!-- claude-skills-mcp-force -->
## MCP REQUIRED

Use ONLY MCP filesystem tools for file operations.

❌ Do NOT use: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `PowerShell`, or CLI MCP (`run_command`, `list_available_clis`)

✅ Use:
- `mcp__filesystem__read_file` (pass `offset`/`limit` to page through large files)
- `mcp__filesystem__write_file`
- `mcp__filesystem__edit_file`
- `mcp__filesystem__list_directory`
- `mcp__filesystem__search_files` (find files by name)
- `mcp__filesystem__search_in_file` (search within one file)
- `mcp__filesystem__search_in_files` (recursive grep across a directory tree)
<!-- /claude-skills-mcp-force -->