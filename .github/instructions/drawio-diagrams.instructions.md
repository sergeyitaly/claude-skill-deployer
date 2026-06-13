---
name: "drawio-diagrams"
description: "Create and edit architecture, network, and infrastructure diagrams as .drawio files using the draw.io MCP server, including Azure architecture diagrams built from the official Microsoft Azure icon set. Use when asked to create, update, or visualize an architecture diagram, infrastructure topology, or system design — especially one involving Azure resources."
applyTo:
  - **/*.drawio
  - **/*.drawio.xml
  - **/diagrams/**
  - **/docs/diagrams/**
  - **/docs/architecture/**
---

# drawio-diagrams

# Draw.io Diagrams (MCP)

Create and maintain architecture diagrams as `.drawio` (mxGraph XML) files,
using the draw.io MCP server when available and falling back to direct XML
editing otherwise.

## 1. Check whether the draw.io MCP server is configured

- Look for a `drawio` (or similar) entry in `.mcp.json` (project) or the
  user's global MCP config.
- If it's missing, offer to add one. Two setups, pick based on the task:

  **Local, full editing (recommended for repo `.drawio` files)** — runs a
  local server that can read/write files on disk and opens a browser UI:
  ```bash
  claude mcp add drawio -- npx @drawio/mcp
  ```

  **Hosted, zero install (view/share only)** — connects to the official
  remote endpoint, useful for interactive viewing in chat hosts that support
  MCP Apps:
  ```bash
  claude mcp add --transport http drawio https://mcp.draw.io/mcp
  ```

  An alternative with deeper programmatic control over edges/layers is
  `lgazo/drawio-mcp` (GitHub) — mention it if the user needs scripted
  edge/layer manipulation beyond what `@drawio/mcp` exposes.

- If the user can't or doesn't want to install an MCP server, fall back to
  editing the `.drawio` XML directly with Read/Edit (section 4) — every
  `.drawio` file is just mxGraph XML, so this always works.

## 2. File conventions

- Store diagram sources under `docs/diagrams/*.drawio` (create the directory
  if it doesn't exist).
- Keep `.drawio` files in version control — they're text-based XML and diff
  reasonably well.
- When a diagram needs to be embedded in docs/README, export a PNG/SVG next
  to the source (`docs/diagrams/<name>.png`) via the MCP server's export tool,
  or `drawio --export` if the desktop CLI is available.

## 3. Azure icons

- The canonical Azure shape set is the Microsoft "Azure" / "Azure Cloud and
  Enterprise" stencil library, browsable at
  https://code.benco.io/icon-collection/azure-icons/ — use this to find the
  correct display name for a resource (e.g. "Storage Accounts", "Key Vaults",
  "Kubernetes Services") before searching for the matching shape.
- In mxGraph XML, Azure shapes use `shape=mxgraph.azure.<name>` (classic set)
  or `shape=mxgraph.azure_meta_cloud_design.<name>` (newer "color" icons),
  e.g.:
  ```xml
  <mxCell id="vm1" value="App Server" style="sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#0078D4;strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;shape=mxgraph.azure.virtual_machine;" vertex="1" parent="1">
    <mxGeometry x="40" y="40" width="48" height="48" as="geometry" />
  </mxCell>
  ```
- When using MCP tools to add shapes, search by the resource's display name
  (e.g. "Virtual Machine", "Application Gateway", "Cosmos DB") rather than
  guessing the exact `shape=` string — the search/list-shapes tool resolves
  it to the correct stencil.

## 4. Workflow for an Azure architecture diagram

1. Identify the resources to depict. If the project has Terraform/Bicep,
   derive the list from `azurerm_*` resources (`grep -r "resource \"azurerm_"`)
   or an existing resource quick-reference from `azure-resource-ops`.
2. Create or open the `.drawio` file:
   - Via MCP: use the server's create/open-file tool, then its
     add-shape/add-node tools for each resource (matching Azure icon by
     resource type) and add-edge tools for connections (network flow,
     dependencies, data flow).
   - Without MCP: write/edit the mxGraph XML directly — start from a minimal
     `<mxfile><diagram><mxGraphModel><root>...</root></mxGraphModel></diagram></mxfile>`
     skeleton and add `<mxCell>` vertices/edges following the style pattern
     in section 3.
3. Group related resources visually (e.g. a container/rectangle for a
   resource group, VNet, or subnet) so the diagram mirrors the deployment
   topology.
4. Save the file, then export PNG/SVG if it needs to be embedded elsewhere.

## 5. Hand-offs

- Resource names/types/topology details → `azure-resource-ops`.
- Terraform-derived module/resource map → `terraform-module-ops`.
- Record any shape names or styles discovered for this project's stack via
  `self-learning`, so future diagrams for the same project reuse them
  without re-searching.
