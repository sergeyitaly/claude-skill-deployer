I want to test the claude-skills-cli MCP server. Please run the following steps in order:

1. Call list_available_clis — show me a table of which CLIs are found on PATH vs missing.

2. Call run_command with cli="git" and args=["--version"] — confirm git responds.

3. Call run_command with cli="node" and args=["--version"] — confirm node responds.

4. Call run_command with cli="npm" and args=["--version"] — confirm npm responds.

5. Call run_command with cli="git" and args=["log", "--oneline", "-5"] — show the last 5 commits of the current repo.

6. (Optional, only if gh is available) Call run_command with cli="gh" and args=["auth", "status"] — check GitHub CLI auth.

After each call, show me the full response: stdout, stderr, exitCode, and whether it timed out.

If any call fails with a tool-not-found or permission error, report the exact error message so I can diagnose the server wiring.