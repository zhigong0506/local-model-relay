$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$Desktop = [Environment]::GetFolderPath('Desktop')
$Shell = New-Object -ComObject WScript.Shell

function New-Shortcut {
    param(
        [string]$Name,
        [string]$Target,
        [string]$Description,
        [string]$Icon
    )

    $linkPath = Join-Path $Desktop $Name
    $shortcut = $Shell.CreateShortcut($linkPath)
    $shortcut.TargetPath = $Target
    $shortcut.WorkingDirectory = $ProjectDir
    $shortcut.Description = $Description
    $shortcut.IconLocation = $Icon
    $shortcut.WindowStyle = 1
    $shortcut.Save()
    Write-Host "Created: $linkPath"
}

New-Shortcut `
    -Name 'Local Model Relay.lnk' `
    -Target (Join-Path $ProjectDir 'open-control-panel.vbs') `
    -Description 'Open Local Model Relay control panel' `
    -Icon "$env:SystemRoot\System32\imageres.dll,109"

New-Shortcut `
    -Name 'Stop Local Model Relay.lnk' `
    -Target (Join-Path $ProjectDir 'stop.bat') `
    -Description 'Stop Local Model Relay' `
    -Icon "$env:SystemRoot\System32\shell32.dll,131"
