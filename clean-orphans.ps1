# Kill `devin acp` processes whose parent is dead (orphans holding session locks).
$killed = @()
Get-CimInstance Win32_Process -Filter "name='devin.exe'" | Where-Object {
    $_.CommandLine -match 'acp' -and -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue)
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $killed += $_.ProcessId
}
Write-Output "killed: $($killed -join ', ')"
