You are investigating a VS Code extension project to understand how it works internally.

Your goals:
1. Understand the architecture and main components
2. Identify how MCP integration works
3. Analyze efficiency/telemetry features
4. Review tests and documentation quality

IMPORTANT RULES:
- Use ONLY MCP filesystem tools for all file access (read_file, list_directory, search_files)
- Do NOT assume anything without inspecting actual files
- Build a mental model step-by-step

---

Step 1 — Explore project structure
- List the root directory
- Identify key folders (extension, src, mcp, scripts, etc.)
- Drill into at least 2–3 directories using list_directory

---

Step 2 — Locate core components
- Search for files related to:
  - MCP (mcpUsageLog, mcpOfficial, mcpForce, index.js)
  - efficiency metrics (efficiencyMetrics.ts)
  - dashboard/UI (costDashboard.ts)
- Use search_files to locate them, then open relevant files

---

Step 3 — Understand MCP integration
- Read the MCP server implementation (index.js)
- Find how logs are written (mcp-usage.jsonl)
- Identify how sessionId is generated and used

---

Step 4 — Trace data flow
- How does a tool call become a KPI?
- Read:
  - mcpUsageLog.ts
  - efficiencyMetrics.ts
- Follow the flow:
  MCP → log → summary → computeScore → UI

---

Step 5 — Analyze inefficiency detection
Look specifically for:
- repeated reads detection
- agent loop detection
- excessive scans detection
- scoring logic

Try to understand:
- how waste is calculated
- how efficiency grade is computed

---

Step 6 — Review MCP Force system
- Find how MCP enforcement works:
  - permissions.deny
  - hooks
  - CLAUDE.md injection
- Read mcpForce.ts and hook-related files
- Explain how enforcement prevents native tool usage

---

Step 7 — Look for potential issues or improvements
- Check for:
  - missing edge case handling
  - performance bottlenecks
  - redundant file reads
  - repeated directory scans

---

Step 8 — Summarize findings
Provide:
- architecture overview
- key strengths
- possible inefficiencies
- suggested improvements

---

IMPORTANT BEHAVIOR:
- Re-read files if needed to verify assumptions
- Explore directories multiple times if unclear (do not assume structure)
- Use search_files for discovery instead of guessing paths
``