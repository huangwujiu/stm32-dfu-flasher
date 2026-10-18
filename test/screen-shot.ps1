# screen-shot.ps1 — 全屏截图（先把鼠标移到角落，避免指针遮挡按钮）
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(4, 4)
Start-Sleep -Milliseconds 400
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$g.Dispose()
$bmp.Save("D:\C_UI_Work\DFU_Programming\test\screen-dump.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("screen saved " + $b.Width + "x" + $b.Height)
