<#
.SYNOPSIS
    Install the Remote SQL Agent worker as a Windows service.

.DESCRIPTION
    Installs to C:\Program Files\RemoteSqlAgent, enrols against the control
    plane with a single-use token, and starts the service.

    The worker connects OUTBOUND ONLY. It opens no listening port, and nothing
    needs to reach this host from the control plane.

.PARAMETER ControlPlane
    host:port of the worker hub, e.g. rsagent.corp.example.com:8443

.PARAMETER EnrolmentToken
    Single-use token from the dashboard: Administration > Workers.
    Expires in one hour and is bound to this host name.

.PARAMETER SqlInstances
    Instance names on this host. Defaults to the default instance.

.PARAMETER MaxCapability
    Local ceiling the control plane can never raise: readOnly | operate |
    schedule | full. Defaults to readOnly. Leave it there unless this host
    genuinely needs to accept changes.

.EXAMPLE
    .\install.ps1 -ControlPlane rsagent.corp.example.com:8443 -EnrolmentToken rsen_xxx

.EXAMPLE
    .\install.ps1 -ControlPlane rsagent:8443 -EnrolmentToken rsen_xxx `
                  -SqlInstances MSSQLSERVER,INST2 -MaxCapability operate
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]   $ControlPlane,
    [Parameter(Mandatory = $true)][string]   $EnrolmentToken,
    [string[]] $SqlInstances  = @('MSSQLSERVER'),
    [ValidateSet('readOnly', 'operate', 'schedule', 'full')]
    [string]   $MaxCapability = 'readOnly',
    [string]   $InstallDir    = "$env:ProgramFiles\RemoteSqlAgent",
    [string]   $CaCertPath    = '',
    [switch]   $SqlAuth,
    [string]   $SqlUser       = '',
    [switch]   $NoTls
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell session: installing a service requires administrator rights.'
}

$source = $PSScriptRoot
Write-Host "Installing Remote SQL Agent worker to $InstallDir"

# --- Files --------------------------------------------------------------------

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# worker.yaml can hold a SQL password (-SqlAuth) and run\worker.key is the
# private key every SQL credential from the control plane is encrypted to —
# capturing either is a full break of the "control plane never holds a usable
# credential" invariant. $InstallDir defaults under Program Files, which
# inherits a Users: Read & Execute ACE, so lock it to Administrators and
# SYSTEM, with inheritance, before anything is created underneath it. The
# per-file Set-Acl calls below still run as defense in depth, but they used
# to be the *only* protection, applied after Set-Content/enrol had already
# written the file into a Users-readable directory — a window any local,
# non-administrator account could read from.
$installAcl = Get-Acl $InstallDir
$installAcl.SetAccessRuleProtection($true, $false)
foreach ($principal in @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM')) {
    $installAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
Set-Acl -Path $InstallDir -AclObject $installAcl
Write-Host "Restricted $InstallDir to Administrators and SYSTEM"

# Created after the parent ACL above so it inherits the restriction rather
# than the Program Files default.
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'run') | Out-Null

foreach ($item in @('rsagent-worker.mjs', 'rsagent-worker.exe', 'rsagent-worker.xml', 'node')) {
    $from = Join-Path $source $item
    if (Test-Path $from) {
        Copy-Item $from -Destination $InstallDir -Recurse -Force
    } else {
        throw "Missing $item in $source. Extract the full worker package before running this script."
    }
}

# --- Configuration ------------------------------------------------------------

$sqlPassword = $null
if ($SqlAuth) {
    if (-not $SqlUser) { throw 'Specify -SqlUser when using -SqlAuth.' }
    # Read as a SecureString so the password is never a script parameter and so
    # it does not land in the PowerShell history or a process listing.
    $secure = Read-Host -AsSecureString "SQL password for $SqlUser"
    $sqlPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

$instanceBlocks = foreach ($instance in $SqlInstances) {
    # A named instance is reached as HOST\INSTANCE; the default instance is
    # just the host name.
    $server = if ($instance -eq 'MSSQLSERVER') { $env:COMPUTERNAME } else { "$env:COMPUTERNAME\$instance" }
    $auth = if ($SqlAuth) {
        "    user: $SqlUser`n    password: `"$sqlPassword`""
    } else {
        '    # Integrated auth: the service account is the SQL principal and no' + "`n" +
        '    # credential is stored on this host at all.'
    }
    @"
  - name: $instance
    server: $server
$auth
    encrypt: true
    trustServerCertificate: true
"@
}

$tlsEnabled = if ($NoTls) { 'false' } else { 'true' }
$caLine = if ($CaCertPath) { "    caCertPath: $CaCertPath" } else { '' }

$config = @"
# Remote SQL Agent worker configuration.
# Generated by install.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss').

hostName: $env:COMPUTERNAME

controlPlane:
  address: $ControlPlane
  auth:
    mode: token
    keyFile: $InstallDir\run\worker.key
  tls:
    enabled: $tlsEnabled
$caLine
  reconnect:
    initialDelayMs: 1000
    maxDelayMs: 60000
    jitterRatio: 0.3

# The local ceiling. The control plane can grant less than this but never more.
# A worker pinned to readOnly cannot be made to write even if the control plane
# is fully compromised.
maxCapability: $MaxCapability

instances:
$($instanceBlocks -join "`n")

outbox:
  path: $InstallDir\run\outbox.sqlite
  maxRows: 100000

polling:
  definitionSeconds: 30
  historySeconds: 10
  activitySeconds: 10
  agentLogSeconds: 60
  heartbeatSeconds: 30

logLevel: info
healthFilePath: $InstallDir\run\health
"@

$configPath = Join-Path $InstallDir 'worker.yaml'
Set-Content -Path $configPath -Value $config -Encoding UTF8
$sqlPassword = $null   # do not leave it in the session

# Belt and suspenders: $InstallDir's ACL already restricts this file to
# Administrators and SYSTEM by inheritance (see above), but state that
# explicitly on the file too rather than relying on inheritance alone.
$acl = Get-Acl $configPath
$acl.SetAccessRuleProtection($true, $false)
foreach ($principal in @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM')) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $principal, 'FullControl', 'Allow')))
}
Set-Acl -Path $configPath -AclObject $acl
Write-Host "Wrote $configPath (Administrators and SYSTEM only)"

# --- Enrol --------------------------------------------------------------------

Write-Host 'Enrolling with the control plane...'
$node = Join-Path $InstallDir 'node\node.exe'
& $node (Join-Path $InstallDir 'rsagent-worker.mjs') 'enrol' '--token' $EnrolmentToken $configPath
if ($LASTEXITCODE -ne 0) {
    throw "Enrolment failed. The token may have expired (they last one hour), already been used, or been issued for a different host name than $env:COMPUTERNAME."
}

# Same explicit belt-and-suspenders treatment for the issued key — it also
# inherited the restriction when enrol created it inside run\.
$keyPath = Join-Path $InstallDir 'run\worker.key'
if (Test-Path $keyPath) {
    $keyAcl = Get-Acl $keyPath
    $keyAcl.SetAccessRuleProtection($true, $false)
    foreach ($principal in @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM')) {
        $keyAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
            $principal, 'FullControl', 'Allow')))
    }
    Set-Acl -Path $keyPath -AclObject $keyAcl
}

# --- Service ------------------------------------------------------------------

$winsw = Join-Path $InstallDir 'rsagent-worker.exe'

if (Get-Service -Name 'rsagent-worker' -ErrorAction SilentlyContinue) {
    Write-Host 'Existing service found; reinstalling.'
    & $winsw stop    | Out-Null
    & $winsw uninstall | Out-Null
    Start-Sleep -Seconds 3
}

& $winsw install
& $winsw start

Start-Sleep -Seconds 5
$service = Get-Service -Name 'rsagent-worker'
Write-Host ''
Write-Host "Service 'rsagent-worker' is $($service.Status)."
Write-Host ''
Write-Host 'Next:'
Write-Host "  - The instance should appear in the dashboard within a minute."
Write-Host "  - Logs: $InstallDir\rsagent-worker.out.log"
Write-Host "  - This worker's ceiling is '$MaxCapability'. Raise it in worker.yaml only if this host must accept changes."

if (-not $NoTls -and -not $CaCertPath) {
    Write-Warning 'No -CaCertPath was given. The worker will verify the control plane against the system trust store; supply the CA certificate if it is privately issued.'
}
