# click-browser.ps1 — 一步完成「定位 Edge 窗口 → 前台化 → 悬停 → 点击」
# 单进程内完成，避免多次 spawn PowerShell 抢焦点导致选择器消失
param(
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [string]$ProfileTag = '',
  [int]$HoverMs = 250
)
$ErrorActionPreference = 'Stop'

Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, int e);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
'@

$procId = 0
if ($ProfileTag -ne '') {
  foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='msedge.exe'")) {
    if ($p.CommandLine -match [regex]::Escape($ProfileTag) -and $p.CommandLine -notmatch '--type=') {
      $procId = $p.ProcessId; break
    }
  }
}

$activated = $false
if ($procId -ne 0) {
  $ws = New-Object -ComObject WScript.Shell
  try { $activated = [bool]$ws.AppActivate($procId) } catch { }
  Start-Sleep -Milliseconds 350
}

# 报告窗口矩形，便于核对坐标空间
$rect = $null
if ($procId -ne 0) {
  $gp = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($gp -and $gp.MainWindowHandle -ne 0) {
    $r = New-Object W.U+RECT
    if ([W.U]::GetWindowRect($gp.MainWindowHandle, [ref]$r)) {
      $rect = @{ l = $r.L; t = $r.T; r = $r.R; b = $r.B }
    }
  }
}

[W.U]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds $HoverMs        # 悬停，让控件进入 hover 态
[W.U]::mouse_event(2, 0, 0, 0, 0)         # LEFTDOWN
Start-Sleep -Milliseconds 70
[W.U]::mouse_event(4, 0, 0, 0, 0)         # LEFTUP
Start-Sleep -Milliseconds 150

$pos = [System.Windows.Forms.Cursor]::Position
Write-Output ("{""ok"":true,""clicked"":[" + $X + "," + $Y + "],""cursor"":[" + $pos.X + "," + $pos.Y +
  "],""activated"":" + $(if ($activated) { "true" } else { "false" }) +
  ",""procId"":" + $procId +
  ",""rect"":" + $(if ($rect) { "{""l"":" + $rect.l + ",""t"":" + $rect.t + ",""r"":" + $rect.r + ",""b"":" + $rect.b + "}" } else { "null" }) + "}")
