# ------------------------------------------------------------------
#  Office Printing - health check.
#
#  Looks at this computer and says what is fine and what needs fixing.
#  It only looks; it never changes anything. No administrator needed.
#  Run it by double-clicking Check-Printing.bat.
# ------------------------------------------------------------------

$ErrorActionPreference = 'SilentlyContinue'
$here = $PSScriptRoot
$script:fails = 0

function Ok($text) {
    Write-Host ("  [OK]   " + $text) -ForegroundColor Green
}
function Bad($text, $fix) {
    Write-Host ("  [FIX]  " + $text) -ForegroundColor Red
    if ($fix) { Write-Host ("         What to do: " + $fix) -ForegroundColor Yellow }
    $script:fails++
}
function Info($text) {
    Write-Host ("  [INFO] " + $text) -ForegroundColor Gray
}
function Heading($text) {
    Write-Host ""
    Write-Host $text -ForegroundColor Cyan
}

# powercfg prints each setting's current plugged-in (AC) and battery (DC)
# value as the last two 0x... numbers in its output.
function Get-PowerValues($sub, $setting) {
    $out = (powercfg /query SCHEME_CURRENT $sub $setting 2>$null) | Out-String
    $found = [regex]::Matches($out, '0x([0-9a-fA-F]{8})')
    if ($found.Count -lt 2) { return $null }
    return @{
        AC = [Convert]::ToInt64($found[$found.Count - 2].Groups[1].Value, 16)
        DC = [Convert]::ToInt64($found[$found.Count - 1].Groups[1].Value, 16)
    }
}

function Test-Zero($label, $sub, $setting, $problem) {
    $v = Get-PowerValues $sub $setting
    if ($null -eq $v) { Info ($label + ": could not be read on this computer."); return }
    if ($v.AC -eq 0 -and $v.DC -eq 0) { Ok $label }
    else { Bad $problem 'Right-click Setup-Printing.bat and choose "Run as administrator".' }
}

$runSetup = 'Right-click Setup-Printing.bat and choose "Run as administrator".'
$hasWeb = Test-Path -LiteralPath (Join-Path $here 'server\server.js')
$hasAgent = Test-Path -LiteralPath (Join-Path $here 'PrintAgent.exe')

Write-Host ""
Write-Host "  ============================================================"
Write-Host "   Office Printing - checking this computer"
Write-Host "  ============================================================"
if ($hasWeb) { Write-Host "   This is the MAIN computer (it runs the printing website)." }
elseif ($hasAgent) { Write-Host "   This is a PRINTER computer (it runs PrintAgent)." }
else {
    Write-Host ""
    Bad "This file is not next to PrintAgent.exe or the 'server' folder." "Keep it in the same folder as the other printing files."
}

# ---------------- every computer ----------------
Heading "Staying awake"
Test-Zero "Never goes to sleep" SUB_SLEEP STANDBYIDLE "This computer is set to go to sleep, which stops printing."
Test-Zero "Never hibernates on a timer" SUB_SLEEP HIBERNATEIDLE "This computer is set to hibernate, which stops printing."
$hib = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Power' -Name HibernateEnabled).HibernateEnabled
if ($hib -eq 0) { Ok "Hibernate is switched off" }
elseif ($null -eq $hib) { Info "Hibernate setting could not be read." }
else { Bad "Hibernate is switched on." $runSetup }
Test-Zero "Closing the lid does nothing" SUB_BUTTONS LIDACTION "Closing the lid would put this computer to sleep."
Test-Zero "The power button will not switch it off by accident" SUB_BUTTONS PBUTTONACTION "A tap on the power button would sleep or shut down this computer."
$screen = Get-PowerValues SUB_VIDEO VIDEOIDLE
if ($screen) {
    if ($screen.AC -eq 0) { Info "The screen never switches off (fine, just uses more power)." }
    else { Info ("The screen switches off after " + [math]::Round($screen.AC / 60) + " minutes (normal - printing keeps working).") }
}
$wu = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' -Name NoAutoRebootWithLoggedOnUsers).NoAutoRebootWithLoggedOnUsers
if ($wu -eq 1) { Ok "Windows Update is told not to restart it while someone is signed in" }
else { Bad "Windows Update may restart this computer by itself." $runSetup }

Heading "Starting by itself"
$startupFile = Join-Path ([Environment]::GetFolderPath('CommonStartup')) 'Office Printing.bat'
$oldStartupFile = Join-Path ([Environment]::GetFolderPath('Startup')) 'Office Printing.bat'
if (Test-Path -LiteralPath $oldStartupFile) {
    Bad "An older start-by-itself entry is still there, so everything may start twice." ("Delete this file: " + $oldStartupFile)
}
if (-not (Test-Path -LiteralPath $startupFile)) {
    Bad "Printing will NOT start by itself when Windows starts." $runSetup
} else {
    $text = Get-Content -LiteralPath $startupFile -Raw
    $m = [regex]::Match($text, '([A-Za-z]:\\[^"]*AutoStart-Printing\.bat)')
    if (-not $m.Success) {
        Bad "The start-by-itself file looks wrong." $runSetup
    } elseif (-not (Test-Path -LiteralPath $m.Groups[1].Value)) {
        Bad ("It points at a folder that no longer exists: " + $m.Groups[1].Value) ("The printing folder was moved or renamed. " + $runSetup)
    } else {
        Ok "Starts by itself when Windows starts"
        $expected = Join-Path $here 'AutoStart-Printing.bat'
        if ($m.Groups[1].Value -ne $expected) {
            Info ("It starts the copy in " + (Split-Path $m.Groups[1].Value) + " - not this folder.")
        }
    }
}

# ---------------- main computer ----------------
if ($hasWeb) {
    Heading "The printing website"

    $node = Get-Command node -CommandType Application | Select-Object -First 1
    if ($node) { Ok ("Node.js is installed (" + (& $node.Path -v) + ")") }
    else { Bad "Node.js is not installed - the website cannot run." "Install the LTS version from https://nodejs.org" }

    $lo = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ } |
        ForEach-Object { Join-Path $_ 'LibreOffice\program\soffice.exe' } |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($lo) { Ok "LibreOffice is installed (Word, Excel and PowerPoint files can print)" }
    else { Bad "LibreOffice is not installed - only PDFs and photos can print." "Install it from https://www.libreoffice.org/download/" }

    $rule = Get-NetFirewallRule -DisplayName 'Office Printing (port 3000)' | Where-Object { $_.Enabled -eq 'True' }
    if ($rule) { Ok "Windows Firewall lets other devices in" }
    else { Bad "Windows Firewall may block other devices from the website." $runSetup }

    $blocked = Get-NetFirewallApplicationFilter | Where-Object { $_.Program -like '*\node.exe' } |
        Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' -and $_.Enabled -eq 'True' }
    if ($blocked) { Bad "Windows Firewall has a rule BLOCKING Node.js (someone clicked Cancel on a firewall pop-up)." $runSetup }

    $alive = $false
    try {
        $r = Invoke-WebRequest -Uri 'http://localhost:3000/api/hello' -UseBasicParsing -TimeoutSec 5
        if ($r.StatusCode -eq 200) { $alive = $true }
    } catch { }
    if ($alive) { Ok "The website is running right now" }
    else { Bad "The website is NOT running right now." "Double-click AutoStart-Printing.bat. If that does not help, run Reset-or-Remove-Printing.bat and choose 1." }

    $ips = Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
    if ($ips) {
        foreach ($ip in $ips) { Info ("Website address: http://" + $ip.IPAddress + ":3000") }
    } else {
        Bad "This computer is not connected to a network." "Connect it to the office Wi-Fi or network cable."
    }
}

# ---------------- any computer with PrintAgent ----------------
if ($hasAgent) {
    Heading "PrintAgent (shares this computer's printer)"

    if (Get-Process -Name PrintAgent) { Ok "PrintAgent is running" }
    else { Bad "PrintAgent is NOT running." "Double-click AutoStart-Printing.bat." }

    $configFile = Join-Path $here 'config.json'
    if (-not (Test-Path -LiteralPath $configFile)) {
        Bad "This computer's printer has not been connected yet." 'Double-click AutoStart-Printing.bat and fill in the "Connect this printer" page that opens.'
    } else {
        $config = $null
        try { $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json } catch { }
        $uri = $null
        if ($config -and $config.serverUrl) { try { $uri = [Uri]$config.serverUrl } catch { } }

        if ($null -eq $uri) {
            Bad "PrintAgent's saved settings are damaged." "Run Reset-or-Remove-Printing.bat, choose 2, and connect again."
        } elseif ($uri.Scheme -ne 'ws' -and $uri.Scheme -ne 'wss') {
            Bad ("PrintAgent's saved website address is in the wrong form: " + $config.serverUrl) "Run Reset-or-Remove-Printing.bat, choose 2, and connect again."
        } else {
            $port = $uri.Port
            if ($port -lt 1) { if ($uri.Scheme -eq 'wss') { $port = 443 } else { $port = 80 } }
            $reached = $false
            $client = New-Object System.Net.Sockets.TcpClient
            try {
                $attempt = $client.BeginConnect($uri.Host, $port, $null, $null)
                if ($attempt.AsyncWaitHandle.WaitOne(3000) -and $client.Connected) { $reached = $true }
            } catch { }
            $client.Close()

            $where = $uri.Host + ":" + $port
            if ($reached) { Ok ("Can reach the printing website at " + $where) }
            elseif ($hasWeb) { Bad ("Cannot reach the website at " + $where + ".") "See 'The printing website' above - it needs to be running first." }
            else {
                Bad ("Cannot reach the printing website at " + $where + ".") ("Check the main computer is switched on and printing is running there, and that this computer is on the same network. If the main computer's address has changed, run Reset-or-Remove-Printing.bat here, choose 2, and connect again with the new address.")
            }
        }
    }

    $printers = Get-CimInstance Win32_Printer |
        Where-Object { $_.Name -notmatch '^(Microsoft Print to PDF|Microsoft XPS Document Writer|Fax|OneNote.*|Send To OneNote.*)$' }
    if ($printers) {
        foreach ($p in $printers) {
            $state = ''
            if ($p.WorkOffline) { $state = ' - Windows says it is OFFLINE' }
            Info ("Printer on this computer: " + $p.Name + $state)
        }
    } else {
        Bad "No printers are installed on this computer." "Plug the printer in and add it in Settings, Bluetooth & devices, Printers & scanners."
    }
}

# ---------------- what actually happened recently ----------------
Heading "Recently"
$since = (Get-Date).AddDays(-1)
$sleeps = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 42; StartTime = $since })
if ($sleeps.Count -eq 0) { Info "It has not gone to sleep in the last 24 hours." }
else { Info ("It went to sleep " + $sleeps.Count + " time(s) in the last 24 hours, most recently " + $sleeps[0].TimeCreated) }
$cuts = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 41; StartTime = (Get-Date).AddDays(-7) })
if ($cuts.Count -gt 0) { Info ("It lost power without shutting down properly " + $cuts.Count + " time(s) in the last 7 days, most recently " + $cuts[0].TimeCreated) }

Write-Host ""
Write-Host "  ============================================================"
if ($script:fails -eq 0) {
    Write-Host "   ALL GOOD" -ForegroundColor Green
} else {
    Write-Host ("   " + $script:fails + " thing(s) to fix - see the red [FIX] lines above.") -ForegroundColor Red
}
Write-Host "  ============================================================"
