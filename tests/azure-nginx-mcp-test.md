# MCP Servers Efficiency Test — Azure Nginx on Public IP

## Purpose
Exercise **both MCP servers** end-to-end on a real infrastructure task.
Every file operation must go through `mcp__filesystem__*`.
Every CLI operation must go through `mcp__claude-skills-cli__run_command`.
Native Read/Write/Bash are not permitted.

---

## Context
Deploy a minimal, production-grade Azure environment containing:
- Resource Group
- Virtual Network + one public subnet
- Network Security Group (HTTP 80, HTTPS 443, SSH 22 inbound; deny-all otherwise)
- Azure Firewall (Standard SKU) with a DNAT rule forwarding :80 → VM :80
- Public IP (Standard SKU, static) attached to the Firewall
- Linux Virtual Machine (Ubuntu 22.04, Standard_B1s) running nginx
- Log Analytics Workspace with VM diagnostics and NSG flow logs
- Boot diagnostics Storage Account

Target location: **westeurope** (change to your nearest region).
All resources share a single Resource Group: `rg-nginx-demo`.

---

## Constraints — read before starting

1. **Use MCP filesystem tools for ALL file I/O.**
   `mcp__filesystem__write_file`, `mcp__filesystem__read_file`, `mcp__filesystem__list_directory`
   Write every generated file under:
   `<workspace>/.claude/azure-nginx-demo/`

2. **Use MCP CLI tools for ALL shell commands.**
   `mcp__claude-skills-cli__run_command` with `cli="az"` or `cli="terraform"`.
   Never open a terminal directly.

3. **Verify before proceeding.** After each major deployment step, run a
   CLI check to confirm the resource exists before moving to the next step.

4. **Log every CLI call result** (stdout, exitCode) in a run-log file at
   `<workspace>/.claude/azure-nginx-demo/run-log.md`
   using `mcp__filesystem__write_file` (append new content each time).

---

## Phase 0 — Preflight

### 0.1 List available CLIs
Call `mcp__claude-skills-cli__list_available_clis`.
Confirm `az` and `terraform` are present.
If either is missing, stop and report.

### 0.2 Check Azure login
```
cli: az
args: ["account", "show", "--output", "json"]
```
If exitCode ≠ 0 → run `az login` equivalent and retry.
Record the subscription name, id, and tenantId.
Write them to `<workspace>/.claude/azure-nginx-demo/subscription.json`
using `mcp__filesystem__write_file`.

---

## Phase 1 — Write Terraform files

Use `mcp__filesystem__write_file` to create every file below.
Check the directory exists first with `mcp__filesystem__list_directory`.

### File: `main.tf`
```hcl
terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.100"
    }
  }
}

provider "azurerm" {
  features {}
}

variable "location"       { default = "westeurope" }
variable "admin_username"  { default = "azureadmin" }
variable "admin_ssh_key"   { description = "SSH public key content" }

locals {
  prefix = "nginx-demo"
  tags   = { environment = "demo", project = "mcp-test" }
}

# ── Resource Group ─────────────────────────────────────────────────────────────
resource "azurerm_resource_group" "rg" {
  name     = "rg-${local.prefix}"
  location = var.location
  tags     = local.tags
}

# ── Log Analytics ──────────────────────────────────────────────────────────────
resource "azurerm_log_analytics_workspace" "law" {
  name                = "law-${local.prefix}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

# ── Virtual Network ────────────────────────────────────────────────────────────
resource "azurerm_virtual_network" "vnet" {
  name                = "vnet-${local.prefix}"
  address_space       = ["10.0.0.0/16"]
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tags                = local.tags
}

resource "azurerm_subnet" "workload" {
  name                 = "snet-workload"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.0.1.0/24"]
}

resource "azurerm_subnet" "firewall" {
  name                 = "AzureFirewallSubnet"   # name is mandatory
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.0.0.0/26"]
}

# ── NSG ───────────────────────────────────────────────────────────────────────
resource "azurerm_network_security_group" "nsg" {
  name                = "nsg-${local.prefix}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tags                = local.tags

  security_rule {
    name                       = "Allow-HTTP"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "Allow-HTTPS"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "Allow-SSH"
    priority                   = 120
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "nsg_assoc" {
  subnet_id                 = azurerm_subnet.workload.id
  network_security_group_id = azurerm_network_security_group.nsg.id
}

# ── Public IP (Firewall) ───────────────────────────────────────────────────────
resource "azurerm_public_ip" "fw_pip" {
  name                = "pip-fw-${local.prefix}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

# ── Azure Firewall ─────────────────────────────────────────────────────────────
resource "azurerm_firewall" "fw" {
  name                = "afw-${local.prefix}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  sku_name            = "AZFW_VNet"
  sku_tier            = "Standard"
  tags                = local.tags

  ip_configuration {
    name                 = "fw-ipconfig"
    subnet_id            = azurerm_subnet.firewall.id
    public_ip_address_id = azurerm_public_ip.fw_pip.id
  }
}

# DNAT rule: public :80 → VM private IP :80
resource "azurerm_firewall_nat_rule_collection" "http_dnat" {
  name                = "dnat-http"
  azure_firewall_name = azurerm_firewall.fw.name
  resource_group_name = azurerm_resource_group.rg.name
  priority            = 100
  action              = "Dnat"

  rule {
    name                  = "http-to-vm"
    source_addresses      = ["*"]
    destination_addresses = [azurerm_public_ip.fw_pip.ip_address]
    destination_ports     = ["80"]
    translated_address    = azurerm_network_interface.nic.private_ip_address
    translated_port       = "80"
    protocols             = ["TCP"]
  }
}

# ── VM NIC ─────────────────────────────────────────────────────────────────────
resource "azurerm_network_interface" "nic" {
  name                = "nic-${local.prefix}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tags                = local.tags

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.workload.id
    private_ip_address_allocation = "Dynamic"
  }
}

# ── Boot Diagnostics Storage ───────────────────────────────────────────────────
resource "azurerm_storage_account" "diag" {
  name                     = "stdiag${replace(local.prefix, "-", "")}01"
  resource_group_name      = azurerm_resource_group.rg.name
  location                 = azurerm_resource_group.rg.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  tags                     = local.tags
}

# ── Virtual Machine ────────────────────────────────────────────────────────────
resource "azurerm_linux_virtual_machine" "vm" {
  name                            = "vm-${local.prefix}"
  resource_group_name             = azurerm_resource_group.rg.name
  location                        = azurerm_resource_group.rg.location
  size                            = "Standard_B1s"
  admin_username                  = var.admin_username
  disable_password_authentication = true
  tags                            = local.tags

  network_interface_ids = [azurerm_network_interface.nic.id]

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.admin_ssh_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  # Install nginx at first boot
  custom_data = base64encode(<<-CLOUD_INIT
    #cloud-config
    package_update: true
    packages:
      - nginx
    runcmd:
      - systemctl enable nginx
      - systemctl start nginx
      - echo "<h1>Hello from Azure MCP Demo — $(hostname)</h1>" > /var/www/html/index.html
  CLOUD_INIT
  )

  boot_diagnostics {
    storage_account_uri = azurerm_storage_account.diag.primary_blob_endpoint
  }
}

# ── Diagnostics → Log Analytics ────────────────────────────────────────────────
resource "azurerm_monitor_diagnostic_setting" "vm_diag" {
  name                       = "diag-vm-to-law"
  target_resource_id         = azurerm_linux_virtual_machine.vm.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.law.id

  metric {
    category = "AllMetrics"
    enabled  = true
  }
}

# ── Outputs ────────────────────────────────────────────────────────────────────
output "firewall_public_ip"  { value = azurerm_public_ip.fw_pip.ip_address }
output "vm_private_ip"       { value = azurerm_network_interface.nic.private_ip_address }
output "log_analytics_id"    { value = azurerm_log_analytics_workspace.law.id }
```

### File: `terraform.tfvars`
```hcl
location      = "westeurope"
admin_username = "azureadmin"
admin_ssh_key  = "ssh-rsa AAAAB3... your-key-here"
```
**Important:** read the user's actual SSH public key from
`~/.ssh/id_rsa.pub` or `~/.ssh/id_ed25519.pub` using
`mcp__filesystem__read_file` and substitute it into `admin_ssh_key`.
If neither exists, note it in the run-log and use a placeholder.

---

## Phase 2 — Terraform init and plan

### 2.1 Init
```
cli: terraform
args: ["init", "-input=false"]
cwd: <workspace>/.claude/azure-nginx-demo/
```
Log result to `run-log.md`.

### 2.2 Plan
```
cli: terraform
args: ["plan", "-input=false", "-out=tfplan", "-var-file=terraform.tfvars"]
cwd: <workspace>/.claude/azure-nginx-demo/
```
Log: resource count, any errors.

---

## Phase 3 — Deploy

### 3.1 Apply
```
cli: terraform
args: ["apply", "-input=false", "-auto-approve", "tfplan"]
cwd: <workspace>/.claude/azure-nginx-demo/
timeout: 900000   # 15 min — Firewall takes 8-10 min
```
Log: apply output, outputs block.

### 3.2 Capture outputs
```
cli: terraform
args: ["output", "-json"]
cwd: <workspace>/.claude/azure-nginx-demo/
```
Write JSON to `mcp__filesystem__write_file` → `outputs.json`.

---

## Phase 4 — Verify with Azure CLI

Run each check in order. After each call log: command, exitCode, relevant stdout.

### 4.1 Resource Group
```
cli: az
args: ["group", "show", "--name", "rg-nginx-demo", "--output", "table"]
```
Expected: `Succeeded` provisioningState.

### 4.2 VM running state
```
cli: az
args: ["vm", "get-instance-view",
       "--resource-group", "rg-nginx-demo",
       "--name", "vm-nginx-demo",
       "--query", "instanceView.statuses[1]",
       "--output", "json"]
```
Expected: `PowerState/running`.

### 4.3 Firewall provisioned
```
cli: az
args: ["network", "firewall", "show",
       "--resource-group", "rg-nginx-demo",
       "--name", "afw-nginx-demo",
       "--query", "{name:name, provisioningState:provisioningState}",
       "--output", "json"]
```
Expected: `Succeeded`.

### 4.4 Public IP address
```
cli: az
args: ["network", "public-ip", "show",
       "--resource-group", "rg-nginx-demo",
       "--name", "pip-fw-nginx-demo",
       "--query", "ipAddress",
       "--output", "tsv"]
```
Store the IP in memory as `$FW_IP`.

### 4.5 HTTP reachability (via az CLI — no curl needed)
```
cli: az
args: ["rest",
       "--method", "GET",
       "--url", "http://<$FW_IP>/",
       "--skip-authorization-header"]
```
If this fails (az rest only does ARM endpoints), note it and instead verify
nginx inside the VM:
```
cli: az
args: ["vm", "run-command", "invoke",
       "--resource-group", "rg-nginx-demo",
       "--name", "vm-nginx-demo",
       "--command-id", "RunShellScript",
       "--scripts", "curl -s http://localhost/ | head -5"]
```
Expected: HTML containing "Hello from Azure MCP Demo".

### 4.6 Log Analytics workspace active
```
cli: az
args: ["monitor", "log-analytics", "workspace", "show",
       "--resource-group", "rg-nginx-demo",
       "--workspace-name", "law-nginx-demo",
       "--query", "{name:name, sku:sku.name, retentionDays:retentionInDays}",
       "--output", "json"]
```

### 4.7 NSG effective rules on workload subnet
```
cli: az
args: ["network", "nsg", "show",
       "--resource-group", "rg-nginx-demo",
       "--name", "nsg-nginx-demo",
       "--query", "securityRules[].{name:name,priority:priority,access:access,direction:direction,port:destinationPortRange}",
       "--output", "table"]
```

---

## Phase 5 — Draw.io Diagram

Write a native draw.io XML file using real Azure icon shapes from the
`mxgraph.azure2` library. Save to:
`<workspace>/.claude/azure-nginx-demo/architecture.drawio`

**Requirements:**
- Use `mxgraph.azure2.*` shape names (not generic shapes)
- Show: Internet → Firewall → NSG → VM → Log Analytics
- Group workload resources inside a VNet boundary box
- Group VNet + Firewall inside a Resource Group boundary
- Add labels with actual resource names from outputs.json

**Shape reference (copy these exactly):**
```
Resource Group:       shape=mxgraph.azure2.resource_group
Virtual Network:      shape=mxgraph.azure2.virtual_networks
Subnet:               shape=mxgraph.azure2.subnet
Azure Firewall:       shape=mxgraph.azure2.firewall
NSG:                  shape=mxgraph.azure2.network_security_group
VM (Linux):           shape=mxgraph.azure2.virtual_machine
Public IP:            shape=mxgraph.azure2.public_ip_addresses
Log Analytics:        shape=mxgraph.azure2.log_analytics
Storage Account:      shape=mxgraph.azure2.storage_account
Internet:             shape=mxgraph.azure2.internet
```

**Draw.io XML skeleton to expand:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1"
              tooltips="1" connect="1" arrows="1" fold="1" page="1"
              pageScale="1" pageWidth="1654" pageHeight="1169"
              math="0" shadow="0">
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>

    <!-- Internet -->
    <mxCell id="2" value="Internet" style="shape=mxgraph.azure2.internet;sketch=0;html=1;pointerEvents=1;dashed=0;fillColor=#0089D6;strokeColor=none;strokeWidth=2;verticalLabelPosition=bottom;verticalAlign=top;align=center;outlineConnect=0;" vertex="1" parent="1">
      <mxGeometry x="80" y="300" width="65" height="65" as="geometry"/>
    </mxCell>

    <!-- Resource Group boundary -->
    <mxCell id="3" value="rg-nginx-demo (West Europe)" style="points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],[1,1],[0.75,1],[0.5,1],[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];shape=mxgraph.azure2.resource_group;whiteSpace=wrap;html=1;sketch=0;fillColor=#E6F3FB;strokeColor=#0089D6;fontStyle=1;fontSize=11;verticalAlign=top;align=left;spacingLeft=30;" vertex="1" parent="1">
      <mxGeometry x="220" y="80" width="1100" height="780" as="geometry"/>
    </mxCell>

    <!-- Public IP -->
    <mxCell id="4" value="pip-fw-nginx-demo&#xa;(Static, Standard)" style="shape=mxgraph.azure2.public_ip_addresses;sketch=0;html=1;pointerEvents=1;dashed=0;fillColor=#0089D6;strokeColor=none;strokeWidth=2;verticalLabelPosition=bottom;verticalAlign=top;align=center;outlineConnect=0;" vertex="1" parent="1">
      <mxGeometry x="270" y="300" width="65" height="65" as="geometry"/>
    </mxCell>

    <!-- Azure Firewall -->
    <mxCell id="5" value="afw-nginx-demo&#xa;(Standard)" style="shape=mxgraph.azure2.firewall;sketch=0;html=1;pointerEvents=1;dashed=0;fillColor=#0089D6;strokeColor=none;strokeWidth=2;verticalLabelPosition=bottom;verticalAlign=top;align=center;outlineConnect=0;" vertex="1" parent="1">
      <mxGeometry x="430" y="300" width="65" height="65" as="geometry"/>
    </mxCell>

    <!-- VNet boundary -->
    <mxCell id="6" value="vnet-nginx-demo (10.0.0.0/16)" style="points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],[1,1],[0.75,1],[0.5,1],[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];shape=mxgraph.azure2.virtual_networks;whiteSpace=wrap;html=1;sketch=0;fillColor=#EBF5FB;strokeColor=#2196F3;fontStyle=1;fontSize=10;verticalAlign=top;align=left;spacingLeft=30;" vertex="1" parent="3">
      <mxGeometry x="260" y="60" width="800" height="680" as="geometry"/>
    </mxCell>

    <!-- Firewall Subnet -->
    <mxCell id="7" value="AzureFirewallSubnet&#xa;10.0.0.0/26" style="shape=mxgraph.azure2.subnet;sketch=0;html=1;whiteSpace=wrap;fillColor=#DDEEFF;strokeColor=#2196F3;fontStyle=0;fontSize=9;verticalAlign=top;" vertex="1" parent="6">
      <mxGeometry x="20" y="80" width="200" height="100" as="geometry"/>
    </mxCell>

    <!-- NSG -->
    <mxCell id="8" value="nsg-nginx-demo&#xa;Allow: 80,443,22" style="shape=mxgraph.azure2.network_security_group;sketch=0;html=1;pointerEvents=1;dashed=0;fillColor=#0089D6;strokeColor=none;strokeWidth=2;verticalLabelPosition=bottom;verticalAlign=top;align=center;outlineConnect=0;" vertex="1" parent="6">
      <mxGeometry x="310" y="110" width="65" height="65" as="geometry"/>
    </mxCell>

    <!-- Workload Subnet -->
    <mxCell id="9" value="snet-workload (10.0.1.0/24)" style="shape=mxgraph.azure2.subnet;sketch=0;html=1;whiteSpace=wrap;fillColor=#E8F5E9;strokeColor=#43A047;fontStyle=0;fontSize=9;verticalAlign=top;" vertex="1" parent="6">
      <mxGeometry x="300" y="260" width="460" height="300" as="geometry"/>
    </mxCell>

    <!-- VM -->
    <mxCell id="10" value="vm-nginx-demo&#xa;(Ubuntu 22.04, B1s)&#xa;nginx running" style="shape=mxgraph.azure2.virtual_machine;sketch=0;html=1;pointerEvents=1;dashed=0;fillColor=#0089D6;strokeColor=none;strokeWidth=2;verticalLabelPosition=bottom;verticalAlign=top;align=center;outlineConnect=0;" vertex="1" parent="9">
      <mxGeometry x="180" y="100" width="65" height="65" as="geometry"/>
    </mxCell>

    <!-- NIC -->
    <mxCell id="11" value="nic-nginx-demo&#xa;(private IP dynamic)" style="shape=mxgraph.azure2.network_interface;sketch=0;html=1;pointerEvents=1;dashed=0;fillColor=#0089D6;strokeColor=none;strokeWidth=2;verticalLabelPosition=bottom;verticalAlign=top;align=center;outlineConnect=0;" vertex="1" parent="9">
      <mxGeometry x="60" y="100" width="65" height="65" as="geometry"/>
    </mxCell>

    <!-- Storage (boot diag) -->
    <mxCell id="12" value="stdiagnginxdemo01&#xa;(Boot diagnostics)" style="shape=mxgraph.azure2.storage_account;sketch=0;html=1;pointerEvents=1;dashed=0;fillColor=#0089D6;strokeColor=none;strokeWidth=2;verticalLabelPosition=bottom;verticalAlign=top;align=center;outlineConnect=0;" vertex="1" parent="3">
      <mxGeometry x="700" y="600" width="65" height="65" as="geometry"/>
    </mxCell>

    <!-- Log Analytics -->
    <mxCell id="13" value="law-nginx-demo&#xa;(PerGB2018, 30d)" style="shape=mxgraph.azure2.log_analytics;sketch=0;html=1;pointerEvents=1;dashed=0;fillColor=#0089D6;strokeColor=none;strokeWidth=2;verticalLabelPosition=bottom;verticalAlign=top;align=center;outlineConnect=0;" vertex="1" parent="3">
      <mxGeometry x="950" y="350" width="65" height="65" as="geometry"/>
    </mxCell>

    <!-- ── Edges ──────────────────────────────────────────────────────── -->

    <!-- Internet → Public IP -->
    <mxCell id="20" style="edgeStyle=orthogonalEdgeStyle;html=1;exitX=1;exitY=0.5;entryX=0;entryY=0.5;strokeColor=#0089D6;strokeWidth=2;" edge="1" source="2" target="4" parent="1">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>

    <!-- Public IP → Firewall -->
    <mxCell id="21" style="edgeStyle=orthogonalEdgeStyle;html=1;exitX=1;exitY=0.5;entryX=0;entryY=0.5;strokeColor=#0089D6;strokeWidth=2;" edge="1" source="4" target="5" parent="1">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>

    <!-- Firewall → NSG (DNAT :80) -->
    <mxCell id="22" value="DNAT :80" style="edgeStyle=orthogonalEdgeStyle;html=1;strokeColor=#F44336;strokeWidth=2;fontColor=#F44336;fontStyle=1;" edge="1" source="5" target="8" parent="1">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>

    <!-- NSG → NIC -->
    <mxCell id="23" style="edgeStyle=orthogonalEdgeStyle;html=1;strokeColor=#43A047;strokeWidth=2;" edge="1" source="8" target="11" parent="6">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>

    <!-- NIC → VM -->
    <mxCell id="24" style="edgeStyle=orthogonalEdgeStyle;html=1;strokeColor=#43A047;strokeWidth=2;" edge="1" source="11" target="10" parent="9">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>

    <!-- VM → Log Analytics (diagnostics) -->
    <mxCell id="25" value="Diagnostics" style="edgeStyle=orthogonalEdgeStyle;html=1;dashed=1;strokeColor=#9C27B0;strokeWidth=1;fontColor=#9C27B0;fontSize=9;" edge="1" source="10" target="13" parent="3">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>

    <!-- VM → Storage (boot diag) -->
    <mxCell id="26" value="Boot diag" style="edgeStyle=orthogonalEdgeStyle;html=1;dashed=1;strokeColor=#FF9800;strokeWidth=1;fontColor=#FF9800;fontSize=9;" edge="1" source="10" target="12" parent="3">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>

  </root>
</mxGraphModel>
```

Write this exactly to `architecture.drawio`, then open it in draw.io
(https://app.diagrams.net) to verify it renders correctly.

---

## Phase 6 — Run log completion

Append a final summary section to `run-log.md`:

```markdown
## Summary

| Check | Result |
|---|---|
| az login | ✓ / ✗ |
| terraform plan | ✓ N resources |
| terraform apply | ✓ / ✗ |
| RG provisioned | ✓ / ✗ |
| VM running | ✓ / ✗ |
| Firewall provisioned | ✓ / ✗ |
| nginx responding | ✓ / ✗ |
| Log Analytics active | ✓ / ✗ |
| Draw.io file written | ✓ / ✗ |

**Public IP:** <value from outputs.json>
**VM private IP:** <value from outputs.json>
**Total MCP calls:**
  - filesystem: <count from mcp-usage.jsonl tail>
  - cli (az): <count>
  - cli (terraform): <count>
```

---

## Phase 7 — Teardown (optional, confirm before running)

Ask the user before proceeding.

```
cli: terraform
args: ["destroy", "-input=false", "-auto-approve", "-var-file=terraform.tfvars"]
cwd: <workspace>/.claude/azure-nginx-demo/
timeout: 900000
```

---

## Scoring rubric (for MCP efficiency review)

After completing all phases, the KPI dashboard should show:
- **Filesystem MCP calls:** ≥ 15 (file writes + reads for verification)
- **CLI MCP calls:** ≥ 12 (az checks + terraform steps)
- **No native Read/Write/Bash used** — confirmed by MCP Force Mode denial
- **Efficiency grade:** A or B (no redundant re-reads of same files)

The run-log.md should be written incrementally (append per phase),
not written once at the end — this tests that the agent uses
`mcp__filesystem__write_file` as a running journal, not batch output.
