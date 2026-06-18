# Extension architecture diagrams

Mermaid diagrams describing how **Claude Skills Manager** (VS Code extension) works.

| # | Diagram | File |
|---|---------|------|
| 0 | Extension registries (VS Marketplace ↔ Open VSX) | [00-extension-registries.md](00-extension-registries.md) |
| 1 | High-level architecture | [01-high-level-architecture.md](01-high-level-architecture.md) |
| 2 | Extension startup and refresh loop | [02-extension-startup.md](02-extension-startup.md) |
| 3 | Skill detection, install, and multi-agent sync | [03-skill-install-sync.md](03-skill-install-sync.md) |
| 4 | Git branch profiles and profile init | [04-branch-profiles-profile-init.md](04-branch-profiles-profile-init.md) |
| 5 | Learning, cost intelligence, and feedback loop | [05-learning-cost-feedback.md](05-learning-cost-feedback.md) |
| 6 | IDE / agent skill sets (branch × Cursor/Kiro/VS Code) | [06-ide-agent-skill-profiles.md](06-ide-agent-skill-profiles.md) |
| 7 | Hook system & MCP architecture | [07-hook-mcp-architecture.md](07-hook-mcp-architecture.md) |

**Draw.io (editable):** [docs/diagrams/skill-profiles-ide-branch-flow.drawio](../docs/diagrams/skill-profiles-ide-branch-flow.drawio)

View on GitHub or in any Markdown preview that supports Mermaid (VS Code with a Mermaid extension, Cursor, etc.).

See also: [00-extension-registries.md](00-extension-registries.md) (VS Marketplace ↔ Open VSX) · [extension/README.md](../extension/README.md) · [README.md](../README.md)
