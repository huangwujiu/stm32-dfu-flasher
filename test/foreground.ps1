# foreground.ps1 - 按 user-data-dir 特征定位 Edge 浏览器进程并前台化
param([Parameter(Mandatory=$true)][string]$ProfileTag)
$ErrorActionPreference = 'Stop'
$procId = 0
foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='msedge.exe'")) {
    if ($p.CommandLine -match [regex]::Escape($ProfileTag) -and $p.CommandLine -notmatch '--type=') {
        $procId = $p.ProcessId
        break
    }
}
if ($procId -eq 0) { Write-Output '{"ok":false,"reason":"process not found"}'; exit 2 }
$ws = New-Object -ComObject WScript.Shell
$ok = $false
try { $ok = [bool]$ws.AppActivate($procId) } catch { }
Start-Sleep -Milliseconds 400
Write-Output ("{""ok"":" + $(if ($ok) { "true" } else { "false" }) + ",""procId"":" + $procId + "}")
if (-not $ok) { exit 3 }
exit 0
