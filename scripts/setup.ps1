# Windows server setup: checks Docker Desktop, detects the LAN IP, generates secrets, writes .env,
# optionally opens the Windows firewall and starts the platform.
#
# Usage (PowerShell, from the project folder):
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1                     # defaults
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Ip 192.168.1.50    # force the server IP
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Port 8080          # other port than 80
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Firewall -Start    # firewall (needs Administrator) + start
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Force              # overwrite .env without asking
param(
    [string]$Ip = "",
    [int]$Port = 80,
    [switch]$Firewall,
    [switch]$Start,
    [switch]$Force
)

$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"

# --- 1. Docker Desktop ---------------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "Docker is not installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop/" -ForegroundColor Red
    Write-Host "(During installation keep 'Use WSL 2 based engine' enabled.) Then run this script again."
    exit 1
}
docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    $desktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $desktop) {
        Write-Host "Docker Desktop is not running - starting it (this can take a minute)..." -ForegroundColor Yellow
        Start-Process $desktop
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Seconds 3
            docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { break }
        }
    }
    docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Docker Desktop is not running. Start it (whale icon says 'Engine running') and run this script again." -ForegroundColor Red
        exit 1
    }
}
Write-Host ("Docker " + (docker version --format '{{.Server.Version}}') + " found.") -ForegroundColor Green

# --- 2. .env -------------------------------------------------------------------------
$keepEnv = $false
if ((Test-Path $envFile) -and -not $Force) {
    $answer = "n"
    if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
        $answer = Read-Host ".env already exists. Overwrite it? (y/N)"
    }
    if ($answer -ne "y") { Write-Host "Keeping the existing .env (use -Force to overwrite)."; $keepEnv = $true }
}

if (-not $keepEnv) {
    if (-not $Ip) {
        $Ip = (Get-NetIPConfiguration |
            Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq "Up" } |
            Select-Object -First 1).IPv4Address.IPAddress
    }
    if (-not $Ip -or $Ip -notmatch '^(\d{1,3}\.){3}\d{1,3}$') {
        Write-Host "Could not detect the LAN IP. Run again with:  -Ip 192.168.x.x" -ForegroundColor Red
        exit 1
    }

    # Cryptographically random secrets
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    function New-RandomString([string]$alphabet, [int]$n) {
        $bytes = New-Object byte[] $n
        $rng.GetBytes($bytes)
        -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
    }
    $adminCode = (New-RandomString "123456789" 1) + (New-RandomString "0123456789" 7)
    $mysqlPass = New-RandomString "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789" 24

@"
BASE_DOMAIN=$Ip.nip.io
HTTP_PORT=$Port
ADMIN_CODE=$adminCode
MYSQL_ROOT_PASSWORD=$mysqlPass
MYSQL_PORT=3306
BUILD_CONCURRENCY=2
NPM_MAXSOCKETS=
IDLE_MINUTES=30
"@ | Set-Content -Path $envFile -Encoding ascii

    $portSuffix = if ($Port -eq 80) { "" } else { ":$Port" }
    Write-Host ""
    Write-Host "Created .env" -ForegroundColor Green
    Write-Host "  Server IP      : $Ip"
    Write-Host "  Dashboard URL  : http://$Ip.nip.io$portSuffix"
    Write-Host "  Admin code     : $adminCode   (keep it safe - also in .env)" -ForegroundColor Yellow
} else {
    $line = Get-Content $envFile | Where-Object { $_ -match '^HTTP_PORT=' } | Select-Object -First 1
    if ($line) { $Port = [int]($line -split '=')[1] }
}

# --- 3. Port check (skipped when the platform already runs - then the ports are ours) ------
$running = docker ps --format '{{.Names}}' 2>$null | Where-Object { $_ -eq 'ws-platform' }
if (-not $running) {
    foreach ($p in @($Port, 3306)) {
        $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn) {
            $proc = (Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue).ProcessName
            Write-Host "Warning: port $p is already used by '$proc' (PID $($conn.OwningProcess))." -ForegroundColor Yellow
            Write-Host "  Stop it (IIS: 'iisreset /stop', XAMPP/WAMP, Skype, local MySQL...) or choose another port with -Port."
        }
    }
}

# --- 4. Firewall (needs Administrator) ------------------------------------------------
if ($Firewall) {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Host "Opening the firewall needs Administrator rights. Re-run PowerShell 'as Administrator' with -Firewall." -ForegroundColor Red
    } else {
        foreach ($rule in @(@{ Name = "WorldSkills platform (HTTP)"; Port = $Port }, @{ Name = "WorldSkills MySQL"; Port = 3306 })) {
            Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
            New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Protocol TCP -LocalPort $rule.Port -Action Allow -Profile Private,Domain | Out-Null
        }
        Write-Host "Firewall: opened TCP $Port and 3306 for Private/Domain networks." -ForegroundColor Green
        $public = Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' }
        if ($public) {
            Write-Host "Note: network '$($public.Name)' is set to Public - other machines are blocked. Make it Private:" -ForegroundColor Yellow
            Write-Host "  Set-NetConnectionProfile -InterfaceAlias '$($public.InterfaceAlias)' -NetworkCategory Private"
        }
    }
}

# --- 5. Start -------------------------------------------------------------------------
if ($Start) {
    Push-Location $root
    docker compose up -d --build
    Pop-Location
    Write-Host ""
    Write-Host "Platform started. Check it with:  docker compose ps   /   docker compose logs -f platform" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Next:"
    if (-not $Firewall) { Write-Host "  (as Administrator) powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Firewall" }
    Write-Host "  docker compose up -d --build"
}
