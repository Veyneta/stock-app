# Generate self-signed certificate for HTTPS development
$cert = New-SelfSignedCertificate -Subject "CN=SmartWarehouse" -DnsName "localhost", "127.0.0.1", "192.168.1.105", "*.local" -KeyAlgorithm RSA -KeyLength 2048 -NotAfter (Get-Date).AddYears(1) -CertStoreLocation "Cert:\CurrentUser\My" -KeyUsage KeyEncipherment,DigitalSignature -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.1")

# Export certificate
$pfxPath = "$PSScriptRoot\cert.pfx"

# Export to PFX
$certPassword = ConvertTo-SecureString -String "dev123" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $certPassword | Out-Null

Write-Host ""
Write-Host "Certificate generated successfully!" -ForegroundColor Green
Write-Host "Location: $PSScriptRoot" -ForegroundColor Cyan
Write-Host ""
Write-Host "Files created:" -ForegroundColor Yellow
Write-Host "  - cert.pfx (use this for Node.js)"
Write-Host ""
Write-Host "To use HTTPS, run: npm run start:https" -ForegroundColor Green
Write-Host ""
Write-Host "Note: You will see a security warning - click 'Advanced' and 'Proceed'" -ForegroundColor Yellow
Write-Host ""
