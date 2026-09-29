$found = $false
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:8080/' -UseBasicParsing -TimeoutSec 20
  'STATUS8080: ' + $r.StatusCode | Write-Host
  'HAS_ERROR_CARD: ' + $r.Content.Contains('page didn') | Write-Host
  'HAS_LANDING: ' + $r.Content.Contains('Study medicine smarter') | Write-Host
  'HAS_404: ' + $r.Content.Contains('Page not found') | Write-Host
  try { 'SERVER_HDR: ' + $r.Headers['Server'] | Write-Host } catch {}
  $found = $true
} catch {
  'REQ8080 FAILED: ' + $_.Exception.Message | Write-Host
}
Get-Process node -ErrorAction SilentlyContinue | Format-Table Id, StartTime, @{l='Cmd';e={(Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.Id)).CommandLine}} -AutoSize | Out-String -Width 500 | Write-Host
'NETSTAT8080:' | Write-Host
netstat -ano -p TCP | Select-String '8080|5199' | Out-String -Width 300 | Write-Host
