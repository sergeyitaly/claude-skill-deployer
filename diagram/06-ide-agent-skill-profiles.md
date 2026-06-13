# IDE and branch skill profile flow

How **Claude Skills Manager** stores, switches, and mirrors skill layouts across **git branches** and **IDEs** (VS Code, Cursor, Kiro, Copilot / Claude Code).

## Architecture overview

```mermaid
flowchart TB
  subgraph IDEs["Development environments"]
    VSCode["VS Code<br/>(Copilot or Claude Code)"]
    Cursor["Cursor IDE"]
    Kiro["Kiro IDE"]
  end

  subgraph Ext["Extension (Claude Skills Manager)"]
    Detect["detectHostAgentId()<br/>app name → agent id"]
    SaveB["saveBranchProfile()"]
    SaveA["saveAgentSkillSet()"]
    ApplyB["applyBranchProfile()"]
    ApplyA["applyAgentSkillSet()"]
    Switch["Switch IDE / Agent Skill Set"]
    Sync["syncWorkspaceSkillsToAllAgents()"]
  end

  subgraph Machine["Machine-local stores (~/.claude/learning/)"]
    BP["branch-profiles.json<br/>1 layout × branch"]
    AP["agent-skill-profiles.json<br/>1 layout × branch × agent"]
    PI["profile.local.json · skills-catalog.json"]
  end

  subgraph WS["Workspace (git repo)"]
    Branch["Git branch<br/>main · feature/x · …"]
    ClaudeSkills[".claude/skills/<br/>source of truth"]
    Overrides[".claude/settings.local.json<br/>skillOverrides off/on"]
    Mirrors["Mirrored agent paths"]
  end

  subgraph MirrorsDetail["Multi-agent mirrors (same effective set)"]
    CursorP[".cursor/skills/"]
    KiroP[".kiro/skills/"]
    CopilotP[".github/instructions/*.instructions.md"]
  end

  VSCode --> Detect
  Cursor --> Detect
  Kiro --> Detect

  Detect --> ApplyA
  Switch --> ApplyA
  ApplyA --> ClaudeSkills
  ApplyB --> ClaudeSkills
  SaveB --> BP
  SaveA --> AP

  Branch --> SaveB
  Branch --> SaveA
  Branch --> ApplyB
  Branch --> ApplyA

  ClaudeSkills --> Overrides
  ClaudeSkills --> Sync
  Sync --> Mirrors
  Mirrors --> CursorP & KiroP & CopilotP

  PI -->|"profile-init (new branch)"| ApplyB
  BP --> ApplyB
  AP --> ApplyA

  IDEs -.->|"reads skills in each IDE"| MirrorsDetail
```

## Save and restore paths

```mermaid
sequenceDiagram
  participant User
  participant IDE as VS Code / Cursor / Kio
  participant Ext as Extension
  participant WS as .claude/skills
  participant BP as branch-profiles.json
  participant AP as agent-skill-profiles.json
  participant Mirror as .cursor / .kiro / Copilot

  Note over User,Mirror: Workspace open (auto-apply)
  IDE->>Ext: activate()
  Ext->>Ext: detectHostAgentId()
  Ext->>AP: load set (branch + agent)
  alt saved IDE set exists
    Ext->>WS: applyAgentSkillSet()
  else branch profile only
    Ext->>BP: load branch profile
    Ext->>WS: applyBranchProfile()
  end
  Ext->>Mirror: syncWorkspaceSkillsToAllAgents()

  Note over User,Mirror: User tunes skills in Cursor
  User->>Ext: toggle skills / proposals
  Ext->>WS: install / skillOverrides
  Ext->>BP: saveBranchProfile (optional)
  Ext->>AP: saveAgentSkillSet (host agent, if enabled)

  Note over User,Mirror: Switch to Kiro on same branch
  User->>IDE: open repo in Kiro
  IDE->>Ext: activate() → agent = kiro
  Ext->>AP: load kiro set for branch
  Ext->>WS: applyAgentSkillSet()
  Ext->>Mirror: sync mirrors

  Note over User,Mirror: Manual switch without reopening IDE
  User->>Ext: Switch IDE / Agent Skill Set
  Ext->>AP: load chosen agent set
  Ext->>WS: apply + sync
```

## Storage model (branch × agent)

```mermaid
flowchart LR
  subgraph Repo["Repo key (origin URL hash)"]
    subgraph Main["branch: main"]
      MCursor["cursor · 12 skills"]
      MKiro["kiro · 9 skills"]
      MCopilot["copilot · 11 skills"]
      MClaude["claude · 14 skills"]
    end
    subgraph Feature["branch: feature/x"]
      FCursor["cursor · 8 skills"]
      FKiro["kiro · 7 skills"]
    end
  end

  Store["agent-skill-profiles.json"]

  Store --> Main
  Store --> Feature

  MCursor & MKiro & MCopilot & MClaude --> Active["applyAgentSkillSet()<br/>→ .claude/skills/"]
  Active --> Sync["propagateWorkspaceSkillChange()"]
```

| Store | Key | Purpose |
|-------|-----|---------|
| `branch-profiles.json` | repo + **branch** | Default per-branch layout (git switch) |
| `agent-skill-profiles.json` | repo + **branch** + **agent** | Per-IDE layout (Cursor vs Kiro vs VS Code) |
| `.claude/skills/` | workspace | Git-tracked or personal skill files (source of truth) |
| `.claude/settings.local.json` | workspace | Personal `skillOverrides` (disable without deleting team files) |

## Host agent detection

| Editor | Detected agent id | Setting override |
|--------|-------------------|------------------|
| Cursor | `cursor` | — |
| Kiro | `kiro` | — |
| VS Code | `copilot` (default) or `claude` | `claudeSkills.agentProfiles.vscodeAgent` |
| Any | forced id | `claudeSkills.agentProfiles.hostAgentOverride` |

## Commands

| Command | Effect |
|---------|--------|
| **Save Skill Set for Current IDE** | Write current effective skills → `agent-skill-profiles.json` for host agent + branch |
| **Switch IDE / Agent Skill Set** | Apply another agent's saved set to `.claude/skills/` and sync mirrors |
| **Save Branch Skill Profile** | Write → `branch-profiles.json` (all IDEs share on branch switch if no IDE set) |
| **Apply Branch Skill Profile** | Restore branch default from `branch-profiles.json` |

## Related diagrams

- [04-branch-profiles-profile-init.md](04-branch-profiles-profile-init.md) — branch switch and profile-init
- [03-skill-install-sync.md](03-skill-install-sync.md) — multi-agent mirror after `.claude/skills` changes
- [00-extension-registries.md](00-extension-registries.md) — installing the extension in each IDE

**Draw.io (editable):** [docs/diagrams/skill-profiles-ide-branch-flow.drawio](../docs/diagrams/skill-profiles-ide-branch-flow.drawio)

← [Diagram index](README.md)
