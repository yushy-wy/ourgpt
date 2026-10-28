# 以调试端口启动一个独立的 Chrome，供 chatgpt-web 适配器复用
# 用法：powershell -ExecutionPolicy Bypass -File scripts\chatgpt-web-browser.ps1

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { Write-Error "Chrome not found at $chrome"; exit 1 }

$profile = Join-Path $env:TEMP "cgpt-oauth-profile"
$settings = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
$args = @(
  "--user-data-dir=$profile",
  "--remote-debugging-port=9222",
  "--no-first-run",
  "--no-default-browser-check",
  "--new-window",
  "https://chatgpt.com"
)
if ($settings.ProxyEnable -eq 1 -and $settings.ProxyServer) {
  $args = @("--proxy-server=http://$($settings.ProxyServer)") + $args
}

Start-Process $chrome -ArgumentList $args
Write-Host "Chrome started with CDP on 127.0.0.1:9222 (profile: $profile)"
Write-Host "Log in to chatgpt.com once; the gateway will reuse this tab."
