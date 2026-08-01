<#
.SYNOPSIS
    One-line installer for the Remote SQL Agent worker.

.DESCRIPTION
    Served by the control plane at /install.ps1 and normally run as:

        iwr https://rsagent.corp.example.com/install.ps1 -UseBasicParsing | iex
        Install-RsAgentWorker -ControlPlane 'rsagent.corp.example.com:8443' -Token 'rsen_...'

    The package is downloaded from the control plane rather than the internet:
    a SQL Server host in a segmented network can always reach the control plane
    — it is about to connect to it — and usually cannot reach GitHub.

    The worker connects OUTBOUND ONLY. Nothing listens on this host and no
    inbound firewall rule is needed.

    No SQL credentials are asked for here. The worker enrols with nothing to
    monitor, and an administrator says which instances to watch from the
    dashboard. Any password they supply is encrypted in their browser to a key
    this host generates below, so the control plane relays a credential it
    cannot itself read.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Install-RsAgentWorker {
    [CmdletBinding()]
    param(
        # host:port of the worker hub.
        [Parameter(Mandatory = $true)][string] $ControlPlane,

        # Single-use enrolment token from the dashboard. Bound to this host name.
        [Parameter(Mandatory = $true)][string] $Token,

        # Local capability ceiling the control plane can never raise.
        [ValidateSet('readOnly', 'operate', 'schedule', 'full')]
        [string] $MaxCapability = 'readOnly',

        # Where to fetch the package from. Defaults to the control plane's
        # dashboard origin, derived from -ControlPlane.
        [string] $PackageUrl = '',

        # Verify the download against this SHA-256. Take the value from the
        # GitHub release, not from the control plane: a checksum served by the
        # same host as the package only detects corruption in transit.
        [string] $PackageSha256 = '',

        [string] $InstallDir = "$env:ProgramFiles\RemoteSqlAgent",

        # Pin a private CA for the hub's TLS certificate.
        [string] $CaCertPath = ''
    )

    if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this from an elevated PowerShell session: installing a service requires administrator rights.'
    }

    if ([Net.ServicePointManager]::SecurityProtocol -notmatch 'Tls12') {
        [Net.ServicePointManager]::SecurityProtocol =
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }

    $hubHost = ($ControlPlane -split ':')[0]
    if (-not $PackageUrl) {
        $PackageUrl = "https://$hubHost/downloads/rsagent-worker-windows.zip"
    }

    $staging = Join-Path $env:TEMP ("rsagent-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $staging | Out-Null

    try {
        $zip = Join-Path $staging 'worker.zip'
        Write-Host "Downloading the worker package from $PackageUrl"
        try {
            Invoke-WebRequest -Uri $PackageUrl -OutFile $zip -UseBasicParsing
        } catch {
            # Deliberately no longer suggests retrying over plain http://.
            # This installs a Windows service on a database server; talking an
            # operator out of TLS to get past a download error is the wrong
            # trade, and it was the example this message led with.
            throw @"
Could not download the worker package from $PackageUrl

  $($_.Exception.Message)

If the control plane serves downloads on a different port or host name, pass the
URL explicitly:

  Install-RsAgentWorker -ControlPlane '$ControlPlane' -Token '<token>' ``
                        -PackageUrl 'https://$hubHost:8443/downloads/rsagent-worker-windows.zip'

If TLS is the problem, fix the certificate or pin your CA with -CaCertPath
rather than falling back to http.
"@
        }

        # Verified when the operator supplies a digest.
        #
        # Threat-model section 1 bounds a compromised control plane by the
        # worker's own maxCapability ceiling. That bound does not hold if the
        # same control plane also ships the binary the ceiling is enforced by,
        # so the value worth checking against is the one published with the
        # GitHub release — not one fetched from the host serving the package,
        # which proves only that the bytes arrived intact.
        if ($PackageSha256) {
            Write-Host 'Verifying the package against the supplied SHA-256'
            $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
            if ($actual -ne $PackageSha256.Replace('-', '').Trim().ToUpperInvariant()) {
                throw "The worker package does not match -PackageSha256 (got $actual). Not installing it."
            }
        } else {
            Write-Host 'Note: no -PackageSha256 given, so the package is trusted because the'
            Write-Host '      control plane served it. See docs/security.md.'
        }

        Expand-Archive -Path $zip -DestinationPath $staging -Force

        $installer = Get-ChildItem -Path $staging -Filter 'install.ps1' -Recurse |
                     Select-Object -First 1
        if (-not $installer) {
            throw "The downloaded package does not contain install.ps1. It may be truncated or the wrong file."
        }

        $arguments = @{
            ControlPlane   = $ControlPlane
            EnrolmentToken = $Token
            MaxCapability  = $MaxCapability
            InstallDir     = $InstallDir
        }
        if ($CaCertPath) { $arguments['CaCertPath'] = $CaCertPath }

        & $installer.FullName @arguments

        Write-Host ''
        Write-Host 'Worker installed and enrolled.' -ForegroundColor Green
        Write-Host 'Next: open the dashboard and tell this worker which SQL instances to monitor.'
        Write-Host 'It is connected but idle until you do.'
    } finally {
        Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
    }
}

# Piping this script into `iex` defines the function; it does not run it, so a
# stray download cannot install anything without an explicit second command.
Write-Host 'Loaded. Now run:' -ForegroundColor Cyan
Write-Host "  Install-RsAgentWorker -ControlPlane '<host:port>' -Token '<enrolment token>'"
