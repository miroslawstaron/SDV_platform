#Requires -RunAsAdministrator
param([ValidateRange(1,65535)][int]$Port=8080)
$ErrorActionPreference='Stop'
$ruleName="SDV-Dashboard-TCP-$Port"
$rule=Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if ($rule) {
    $rule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Any
    $rule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $Port -RemotePort Any
} else {
    New-NetFirewallRule -Name $ruleName -DisplayName "SDV dashboard (TCP $Port)" `
        -Description 'Allow remote access to the SDV web dashboard, including its proxied API and instruments.' `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Any -Enabled True | Out-Null
}
Write-Host "Inbound TCP $Port is allowed by firewall rule $ruleName."
