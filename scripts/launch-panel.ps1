$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$Port = 25818
$Url = "http://127.0.0.1:$Port/admin"
$HealthUrl = "http://127.0.0.1:$Port/health"

function Test-RelayHealth {
    try {
        $response = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
        return [bool]$response.ok
    } catch {
        return $false
    }
}

function Show-RelayMessage($message) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($message, 'Local Model Relay') | Out-Null
}

if (-not (Test-RelayHealth)) {
    $starter = Join-Path $ProjectDir 'start-hidden.vbs'
    Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$starter`"" -WorkingDirectory $ProjectDir -WindowStyle Hidden
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-RelayHealth) { break }
    }
}

if (Test-RelayHealth) {
    Start-Process $Url
} else {
    $logPath = Join-Path $ProjectDir 'logs\relay.log'
    Show-RelayMessage "Local Model Relay 未能启动。可能是端口 $Port 被占用，或 Node.js 不可用。`n`n日志位置：$logPath"
}
