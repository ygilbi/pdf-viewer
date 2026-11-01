<#
.SYNOPSIS
  Smoke test for the PDF Viewer NSIS installer (per-user install).

.DESCRIPTION
  1. Runs the installer silently (/S) and waits for the uninstall registry entry.
  2. Locates the install dir from HKCU\...\Uninstall\* (DisplayName "PDF Viewer*").
  3. Asserts PDFViewer.exe, the file-association registry keys, and the DefaultIcon .ico.
  4. Launches PDFViewer.exe with a PDF, checks the process and window title, takes a screenshot.
  5. Kills the app, runs the uninstaller silently and asserts the keys are removed.
  Prints a summary table (also to $env:GITHUB_STEP_SUMMARY) and exits 1 on any failure.

  Compatible with Windows PowerShell 5.1 and PowerShell 7+. ASCII only on purpose.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File desktop\test\smoke.ps1 -Installer desktop\release\PDF-Viewer-Setup-1.0.0.exe -Pdf public\demo-facade.pdf -OutDir smoke-out
#>
[CmdletBinding()]
param(
  [string]$Installer = '',
  [string]$Pdf = '',
  [string]$OutDir = '',
  [int]$LaunchWaitSeconds = 10,
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Installer) {
  $found = Get-ChildItem -Path (Join-Path $RepoRoot 'desktop\release') -Filter 'PDF-Viewer-Setup-*.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($found) { $Installer = $found.FullName }
}
if (-not $Pdf) { $Pdf = Join-Path $RepoRoot 'public\demo-facade.pdf' }
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot 'desktop\test\out' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$ProductName = 'PDF Viewer'
$ExeName = 'PDFViewer.exe'
$ProgId = 'PDFViewer.Document'
$UninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$ProgIdKey = "HKCU:\Software\Classes\$ProgId"
$DefaultIconKey = "$ProgIdKey\DefaultIcon"
$OpenCommandKey = "$ProgIdKey\shell\open\command"
$OpenWithKey = 'HKCU:\Software\Classes\.pdf\OpenWithProgids'
$CapabilitiesKey = 'HKCU:\Software\PDFViewer\Capabilities'
$FileAssocKey = "$CapabilitiesKey\FileAssociations"
$RegisteredAppsKey = 'HKCU:\Software\RegisteredApplications'
$CapabilitiesPath = 'Software\PDFViewer\Capabilities'

# ---------------------------------------------------------------- helpers
$script:Results = New-Object System.Collections.ArrayList

function Add-Result {
  param([string]$Check, [string]$Status, [string]$Detail = '')
  [void]$script:Results.Add([pscustomobject]@{ Check = $Check; Result = $Status; Detail = $Detail })
  $line = '[{0}] {1}' -f $Status, $Check
  if ($Detail) { $line = "$line -- $Detail" }
  Write-Host $line
}

function Assert-True {
  param([string]$Check, [bool]$Condition, [string]$Detail = '')
  if ($Condition) { Add-Result $Check 'PASS' $Detail } else { Add-Result $Check 'FAIL' $Detail }
  return $Condition
}

# Returns the value (string) or $null when the key or value does not exist. '' = default value.
function Get-RegValue {
  param([string]$Path, [string]$Name)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $key = Get-Item -LiteralPath $Path
  $names = @($key.GetValueNames())
  if ($Name -eq '') {
    if (-not ($names -contains '')) { return $null }
  } elseif (-not ($names -contains $Name)) {
    return $null
  }
  return [string]$key.GetValue($Name)
}

function Get-UninstallEntry {
  if (-not (Test-Path -LiteralPath $UninstallRoot)) { return $null }
  foreach ($k in Get-ChildItem -LiteralPath $UninstallRoot) {
    $dn = [string]$k.GetValue('DisplayName')
    if ($dn -eq $ProductName -or $dn -like "$ProductName *") { return $k }
  }
  return $null
}

function Wait-Until {
  param([scriptblock]$Condition, [int]$Seconds)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return [bool](& $Condition)
}

# Splits '"C:\path\x.exe" /a /b' or 'C:\path\x.exe /a' into exe + args.
function Split-CommandLine {
  param([string]$CommandLine)
  $c = $CommandLine.Trim()
  if ($c.StartsWith('"')) {
    $end = $c.IndexOf('"', 1)
    return @($c.Substring(1, $end - 1), $c.Substring($end + 1).Trim())
  }
  $m = [regex]::Match($c, '^(.+?\.exe)\s*(.*)$', 'IgnoreCase')
  if ($m.Success) { return @($m.Groups[1].Value, $m.Groups[2].Value) }
  return @($c, '')
}

function Stop-App {
  Get-Process -Name 'PDFViewer' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  [void](Wait-Until { -not (Get-Process -Name 'PDFViewer' -ErrorAction SilentlyContinue) } 15)
}

function Save-Screenshot {
  param([string]$Path)
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $g.Dispose()
    $bmp.Dispose()
  }
}

function Write-Summary {
  Write-Host ''
  Write-Host '==================== SMOKE TEST SUMMARY ===================='
  $script:Results | Format-Table -AutoSize -Wrap Check, Result, Detail | Out-String -Width 400 | Write-Host
  $fails = @($script:Results | Where-Object { $_.Result -eq 'FAIL' }).Count
  $passes = @($script:Results | Where-Object { $_.Result -eq 'PASS' }).Count
  $warns = @($script:Results | Where-Object { $_.Result -eq 'WARN' }).Count
  Write-Host ("PASS: {0}   FAIL: {1}   WARN: {2}" -f $passes, $fails, $warns)
  if ($env:GITHUB_STEP_SUMMARY) {
    $md = New-Object System.Collections.ArrayList
    [void]$md.Add('## Windows installer smoke test')
    [void]$md.Add('')
    [void]$md.Add(("**PASS:** {0} &nbsp; **FAIL:** {1} &nbsp; **WARN:** {2}" -f $passes, $fails, $warns))
    [void]$md.Add('')
    [void]$md.Add('| Check | Result | Detail |')
    [void]$md.Add('|---|---|---|')
    foreach ($r in $script:Results) {
      $d = ($r.Detail -replace '\|', '\|' -replace "`r?`n", ' ')
      [void]$md.Add(('| {0} | {1} | `{2}` |' -f $r.Check, $r.Result, $d))
    }
    Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value ($md -join "`n") -Encoding UTF8
  }
  return $fails
}

# ---------------------------------------------------------------- run
$exitCode = 0
try {
  # ---- 0. inputs
  if (-not (Assert-True 'Installer file exists' ($Installer -and (Test-Path -LiteralPath $Installer)) "$Installer")) { throw 'No installer' }
  $Installer = (Resolve-Path -LiteralPath $Installer).Path
  [void](Assert-True 'Test PDF exists' (Test-Path -LiteralPath $Pdf) "$Pdf")
  if (Get-UninstallEntry) { Add-Result 'Clean machine before install' 'WARN' 'An existing PDF Viewer install was found' }

  # ---- 1. silent install
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru
  $null = $p.Handle  # keeps ExitCode available on Windows PowerShell 5.1
  $p.WaitForExit()
  $registered = Wait-Until { $null -ne (Get-UninstallEntry) } $TimeoutSeconds
  [void](Assert-True 'Silent install (/S) finished' ($p.ExitCode -eq 0) ("exit code {0}, {1:N0}s" -f $p.ExitCode, $sw.Elapsed.TotalSeconds))
  # NSIS may open the "Default apps" settings page after install; close it so it does not cover the screenshot.
  Get-Process -Name 'SystemSettings' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if (-not (Assert-True 'Uninstall entry registered (HKCU)' $registered 'DisplayName like "PDF Viewer*"')) { throw 'Not installed' }

  # ---- 2. install dir
  $entry = Get-UninstallEntry
  $installDir = [string]$entry.GetValue('InstallLocation')
  $uninstallCmd = [string]$entry.GetValue('QuietUninstallString')
  if (-not $uninstallCmd) { $uninstallCmd = [string]$entry.GetValue('UninstallString') }
  if (-not $installDir -and $uninstallCmd) { $installDir = Split-Path -Parent (Split-CommandLine $uninstallCmd)[0] }
  $installDir = $installDir.Trim('"').TrimEnd('\')
  Add-Result 'Install dir located' 'PASS' $installDir
  $exe = Join-Path $installDir $ExeName
  [void](Assert-True "$ExeName exists" (Test-Path -LiteralPath $exe) $exe)

  # ---- 3. registry contract
  $icon = Get-RegValue $DefaultIconKey ''
  [void](Assert-True 'ProgID DefaultIcon set' ($null -ne $icon -and $icon -like '*file-pdf.ico*') "$icon")
  $iconPath = ''
  if ($icon) { $iconPath = (($icon -replace ',\s*-?\d+\s*$', '').Trim()).Trim('"') }
  $expectedIcon = Join-Path $installDir 'resources\file-pdf.ico'
  [void](Assert-True 'DefaultIcon points into install dir' ($iconPath -and ($iconPath -ieq $expectedIcon)) "expected $expectedIcon")
  $iconOk = $false
  $iconDetail = $iconPath
  if ($iconPath -and (Test-Path -LiteralPath $iconPath)) {
    $bytes = [System.IO.File]::ReadAllBytes($iconPath)
    $iconOk = ($bytes.Length -ge 6 -and $bytes[0] -eq 0 -and $bytes[1] -eq 0 -and $bytes[2] -eq 1 -and $bytes[3] -eq 0)
    $count = 0
    if ($bytes.Length -ge 6) { $count = [int]$bytes[4] + 256 * [int]$bytes[5] }
    $iconDetail = "$iconPath ($($bytes.Length) bytes, $count image(s))"
  }
  [void](Assert-True 'DefaultIcon file is a valid .ico (00 00 01 00)' $iconOk $iconDetail)

  $cmd = Get-RegValue $OpenCommandKey ''
  [void](Assert-True 'shell\open\command uses PDFViewer.exe' ($null -ne $cmd -and $cmd -like "*$ExeName*") "$cmd")
  [void](Assert-True '.pdf\OpenWithProgids has PDFViewer.Document' ($null -ne (Get-RegValue $OpenWithKey $ProgId)) $OpenWithKey)
  $assoc = Get-RegValue $FileAssocKey '.pdf'
  [void](Assert-True 'Capabilities\FileAssociations .pdf' ($assoc -eq $ProgId) "$assoc")
  $regApp = Get-RegValue $RegisteredAppsKey $ProductName
  [void](Assert-True 'RegisteredApplications "PDF Viewer"' ($regApp -eq $CapabilitiesPath) "$regApp")

  # ---- 4. launch with a PDF
  if (Test-Path -LiteralPath $exe) {
    $pdfFull = (Resolve-Path -LiteralPath $Pdf).Path
    $app = Start-Process -FilePath $exe -ArgumentList ('"{0}"' -f $pdfFull) -PassThru
    Start-Sleep -Seconds $LaunchWaitSeconds
    $titled = $null
    $gotTitle = Wait-Until {
      $script:titled = Get-Process -Name 'PDFViewer' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -like '*PDF Viewer*' } | Select-Object -First 1
      $null -ne $script:titled
    } 30
    $alive = $null -ne (Get-Process -Name 'PDFViewer' -ErrorAction SilentlyContinue)
    [void](Assert-True 'App process alive after launch' $alive ("started pid {0}" -f $app.Id))
    $titles = (Get-Process -Name 'PDFViewer' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } |
      ForEach-Object { $_.MainWindowTitle }) -join ' / '
    [void](Assert-True 'Window title contains "PDF Viewer"' $gotTitle "$titles")

    $shot = Join-Path $OutDir 'app-screenshot.png'
    try {
      Save-Screenshot $shot
      Add-Result 'Screenshot saved' 'PASS' $shot
    } catch {
      Add-Result 'Screenshot saved' 'WARN' $_.Exception.Message
    }
    Stop-App
  } else {
    Add-Result 'Launch app' 'FAIL' 'skipped: exe missing'
  }

  # ---- 5. silent uninstall
  if ($uninstallCmd) {
    $parts = Split-CommandLine $uninstallCmd
    $uArgs = $parts[1]
    if ($uArgs -notmatch '(^|\s)/S(\s|$)') { $uArgs = ("$uArgs /S").Trim() }
    $u = Start-Process -FilePath $parts[0] -ArgumentList $uArgs -PassThru
    $null = $u.Handle
    $u.WaitForExit()
    # The NSIS uninstaller re-launches itself from %TEMP%, so wait for the entry to disappear.
    $gone = Wait-Until { $null -eq (Get-UninstallEntry) } $TimeoutSeconds
    [void](Assert-True 'Silent uninstall removed uninstall entry' $gone ("exit code {0}; {1} {2}" -f $u.ExitCode, $parts[0], $uArgs))
    [void](Wait-Until { -not (Test-Path -LiteralPath $exe) } 30)
    [void](Assert-True "$ExeName removed" (-not (Test-Path -LiteralPath $exe)) $exe)
    [void](Assert-True 'ProgID key removed' (-not (Test-Path -LiteralPath $ProgIdKey)) $ProgIdKey)
    [void](Assert-True 'OpenWithProgids value removed' ($null -eq (Get-RegValue $OpenWithKey $ProgId)) $OpenWithKey)
    [void](Assert-True 'Capabilities key removed' (-not (Test-Path -LiteralPath $CapabilitiesKey)) $CapabilitiesKey)
    [void](Assert-True 'RegisteredApplications value removed' ($null -eq (Get-RegValue $RegisteredAppsKey $ProductName)) $RegisteredAppsKey)
  } else {
    Add-Result 'Uninstall command found' 'FAIL' 'no QuietUninstallString / UninstallString'
  }
} catch {
  Add-Result 'Smoke test aborted' 'FAIL' $_.Exception.Message
} finally {
  Stop-App
}

$failCount = Write-Summary
if ($failCount -gt 0) { $exitCode = 1 }
exit $exitCode
