param(
    [Parameter(Mandatory = $true)][uri]$Url,
    [string]$PrinterName = 'MEVA TP-UNW'
)
$ErrorActionPreference = 'Stop'
if ($Url.Scheme -ne 'https' -or $Url.UserInfo -or -not $Url.Host) {
    throw 'Use the HTTPS Labelmod address without embedded credentials.'
}
$printer = Get-CimInstance Win32_Printer | Where-Object Default | Select-Object -First 1
if (-not $printer -or $printer.Name -ne $PrinterName -or ($printer.Name + ' ' + $printer.DriverName) -match 'PDF|OneNote|XPS|Fax') {
    throw "Set the physical receipt printer '$PrinterName' as the Windows default first. No printer settings were changed."
}
$edge = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge is not installed.' }
$profile = Join-Path $env:LOCALAPPDATA 'Labelmod\ReceiptEdgeProfile'
# A separate profile keeps these print settings away from ordinary browsing.
# No global policy, default-printer change, installer, or background service.
Start-Process -FilePath $edge -ArgumentList @(
    "--user-data-dir=`"$profile`"",
    '--kiosk-printing',
    "--app=`"$($Url.AbsoluteUri)`""
)
