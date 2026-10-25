# Puts a "My Dashboard" shortcut on your Desktop. Add -Autostart to also start it when you sign in to Windows.
#   powershell -ExecutionPolicy Bypass -File install-shortcut.ps1 [-Autostart] [-Remove]
param([switch]$Autostart, [switch]$Remove)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $here 'start.cmd'
$desktop = [Environment]::GetFolderPath('Desktop')
$startup = [Environment]::GetFolderPath('Startup')
$places = @((Join-Path $desktop 'My Dashboard.lnk'))
if ($Autostart) { $places += (Join-Path $startup 'My Dashboard.lnk') }

if ($Remove) {
  foreach ($p in @((Join-Path $desktop 'My Dashboard.lnk'), (Join-Path $startup 'My Dashboard.lnk'))) {
    if (Test-Path $p) { Remove-Item $p; Write-Host "Removed $p" }
  }
  exit 0
}

$shell = New-Object -ComObject WScript.Shell
foreach ($p in $places) {
  $s = $shell.CreateShortcut($p)
  $s.TargetPath = $target
  $s.WorkingDirectory = $here
  $s.WindowStyle = 7  # minimized
  $s.Description = 'My Dashboard: agents, tools and programs (http://localhost:4800)'
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($node) { $s.IconLocation = "$node,0" }
  $s.Save()
  Write-Host "Created $p"
}
