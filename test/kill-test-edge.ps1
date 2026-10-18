# kill-test-edge.ps1 - 仅关闭命令行带本项目测试 profile 的 Edge 实例，不动用户日常浏览器
$procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like '*DFU_Programming*' }
if ($procs) {
  $procs | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Output ("killed edge pid " + $_.ProcessId)
  }
} else {
  Write-Output "no stale test edge instance"
}
