# win-info.ps1 — 定位 Edge 主窗口并输出矩形（取面积最大的带标题窗口）
param([Parameter(Mandatory=$true)][string]$ProfileTag)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode)]
static extern System.IntPtr FindWindowEx(System.IntPtr parent, System.IntPtr after, string cls, string name);
[DllImport("user32.dll", CharSet=CharSet.Unicode)]
static extern int GetWindowTextW(System.IntPtr h, System.Text.StringBuilder s, int max);
[DllImport("user32.dll")] static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[DllImport("user32.dll")] static extern System.IntPtr GetWindow(System.IntPtr h, uint uCmd);
[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint procId);
[DllImport("user32.dll")] static extern bool IsWindowVisible(System.IntPtr h);
[StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
public static System.Collections.Generic.List<System.IntPtr> TopWindows(uint pid) {
    var res = new System.Collections.Generic.List<System.IntPtr>();
    System.IntPtr h = FindWindowEx(System.IntPtr.Zero, System.IntPtr.Zero, null, null);
    while (h != System.IntPtr.Zero) {
        uint p; GetWindowThreadProcessId(h, out p);
        if (p == pid && IsWindowVisible(h)) res.Add(h);
        h = GetWindow(h, 2);
    }
    return res;
}
public static string Text(System.IntPtr h) { var sb = new System.Text.StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }
public static int[] Rect(System.IntPtr h) { RECT r; if (!GetWindowRect(h, out r)) return null; return new int[]{ r.Left, r.Top, r.Right, r.Bottom }; }
'@
$procId = 0
foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='msedge.exe'")) {
    if ($p.CommandLine -match [regex]::Escape($ProfileTag) -and $p.CommandLine -notmatch '--type=') {
        $procId = $p.ProcessId
        break
    }
}
if ($procId -eq 0) { Write-Output '{"ok":false,"reason":"process not found"}'; exit 2 }

$best = $null; $bestArea = 0
foreach ($w in [W.U]::TopWindows([uint32]$procId)) {
    $t = [W.U]::Text($w)
    $r = [W.U]::Rect($w)
    if (-not $r) { continue }
    $area = ($r[2] - $r[0]) * ($r[3] - $r[1])
    # 只接受「够大」且（有标题或面积很大）的窗口
    if ($area -lt 200000) { continue }
    if ($area -gt $bestArea) { $bestArea = $area; $best = $r }
}
if (-not $best) { Write-Output '{"ok":false,"reason":"main window not found"}'; exit 3 }
Write-Output ("{""ok"":true,""procId"":" + $procId + ",""rect"":[" + ($best -join ",") +
  "],""w"":" + ($best[2] - $best[0]) + ",""h"":" + ($best[3] - $best[1]) + "}")
