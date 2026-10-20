# Local test server - no PHP needed. Does the same job as data.php / buzzer.php,
# serves the dashboard, and PUSHES every new reading to open dashboards instantly
# (Server-Sent Events on /events).
# Start it by double-clicking start-server.bat (stop with Ctrl+C or close the window).

param([int]$Port = 8000)

$root    = $PSScriptRoot
$dataDir = Join-Path $root 'data'
New-Item -ItemType Directory -Force $dataDir | Out-Null
$historySize = 400

# Use the same API key as config.php
$apiKey = ([regex]::Match((Get-Content -Raw (Join-Path $root 'config.php')), "API_KEY\s*=\s*'([^']*)'")).Groups[1].Value

$historyFile = Join-Path $dataDir 'history.json'
$latestFile  = Join-Path $dataDir 'latest.json'
$controlFile = Join-Path $dataDir 'control.json'

# Readings are kept as ready-made JSON strings so responses are instant
$history    = New-Object System.Collections.Generic.List[string]
$latestJson = 'null'
$buzzer     = 'auto'
$beep       = 0     # counts website claps; the ESP32 buzzes when it goes up
if (Test-Path $historyFile) {
    try { foreach ($h in (ConvertFrom-Json -InputObject (Get-Content -Raw $historyFile))) { $history.Add((ConvertTo-Json -InputObject $h -Compress)) } } catch {}
    if ($history.Count) { $latestJson = $history[$history.Count - 1] }
}
if (Test-Path $controlFile) {
    try {
        $ctl = ConvertFrom-Json -InputObject (Get-Content -Raw $controlFile)
        if ($ctl.buzzer) { $buzzer = $ctl.buzzer }
        if ($ctl.beep) { $beep = [int]$ctl.beep }
    } catch {}
}

$sseClients = New-Object System.Collections.ArrayList
$dirty = $false

$types = @{ '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css'; '.js' = 'application/javascript'
            '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon' }
$reasons = @{ 200 = 'OK'; 400 = 'Bad Request'; 401 = 'Unauthorized'; 404 = 'Not Found'; 405 = 'Method Not Allowed' }
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Now { [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }

function Num($v) {
    if ($null -eq $v) { return $null }
    $d = 0.0
    if ([double]::TryParse([string]$v, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$d)) {
        return [math]::Round($d, 1)
    }
    return $null
}

function Clean($v) {
    $s = ([string]$v) -replace '<[^>]*>', ''
    if ($s.Length -gt 40) { $s = $s.Substring(0, 40) }
    return $s
}

function ControlJson { '{"buzzer":"' + $script:buzzer + '","beep":' + $script:beep + '}' }

function StateJson([bool]$withHistory) {
    $s = '{"latest":' + $script:latestJson + ',"control":' + (ControlJson) + ',"serverTime":' + (Now)
    if ($withHistory) { $s += ',"history":[' + ($script:history -join ',') + ']' }
    return $s + '}'
}

function Send($stream, [int]$status, [string]$type, [byte[]]$body) {
    $head = "HTTP/1.1 $status $($reasons[$status])`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
    $h = [Text.Encoding]::ASCII.GetBytes($head)
    $stream.Write($h, 0, $h.Length)
    if ($body.Length) { $stream.Write($body, 0, $body.Length) }
}

function SendJsonText($stream, [int]$status, [string]$json) { Send $stream $status 'application/json' $utf8.GetBytes($json) }
function SendJson($stream, [int]$status, $obj) { SendJsonText $stream $status (ConvertTo-Json -InputObject $obj -Compress) }

# Push the current state to every open dashboard
function Broadcast {
    if (-not $script:sseClients.Count) { return }
    $bytes = $utf8.GetBytes("data: $(StateJson $false)`n`n")
    foreach ($c in @($script:sseClients)) {
        try { $c.GetStream().Write($bytes, 0, $bytes.Length) }
        catch { [void]$script:sseClients.Remove($c); $c.Close() }
    }
}

function SaveData {
    Set-Content -Encoding UTF8 $historyFile ('[' + ($script:history -join ',') + ']')
    Set-Content -Encoding UTF8 $latestFile $script:latestJson
}

# Returns 'keep' when the connection must stay open (event stream)
function Handle($client) {
    $stream = $client.GetStream()
    $stream.ReadTimeout = 3000
    $reader = New-Object System.IO.StreamReader($stream, $utf8)

    $requestLine = $reader.ReadLine()
    if (-not $requestLine) { return }
    $method, $target = $requestLine.Split(' ')[0, 1]
    $path = [Uri]::UnescapeDataString($target.Split('?')[0])
    $query = if ($target.Contains('?')) { $target.Split('?', 2)[1] } else { '' }

    $headers = @{}
    while (($line = $reader.ReadLine())) {
        $i = $line.IndexOf(':')
        if ($i -gt 0) { $headers[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim() }
    }
    $body = ''
    if ($headers['Content-Length']) {
        $buf = New-Object char[] ([int]$headers['Content-Length'])
        $read = 0
        while ($read -lt $buf.Length) {
            $n = $reader.Read($buf, $read, $buf.Length - $read)
            if ($n -le 0) { break }
            $read += $n
        }
        $body = New-Object string($buf, 0, $read)
    }

    if ($path -eq '/events') {
        $client.SendTimeout = 2000
        $h = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: text/event-stream`r`nCache-Control: no-store`r`nConnection: keep-alive`r`n`r`nretry: 1500`n`n")
        $stream.Write($h, 0, $h.Length)
        $first = $utf8.GetBytes("data: $(StateJson $false)`n`n")
        $stream.Write($first, 0, $first.Length)
        [void]$script:sseClients.Add($client)
        return 'keep'
    }

    if ($path -eq '/data.php') {
        if ($method -eq 'POST') {
            if ($headers['X-API-Key'] -cne $script:apiKey) {
                Write-Host "$(Get-Date -f HH:mm:ss)  REJECTED reading from $($client.Client.RemoteEndPoint): wrong API key" -ForegroundColor Red
                return SendJson $stream 401 @{ error = 'invalid API key' }
            }
            try { $in = ConvertFrom-Json -InputObject $body } catch { return SendJson $stream 400 @{ error = 'body must be JSON' } }
            $reading = [ordered]@{
                temperature = Num $in.temperature
                humidity    = Num $in.humidity
                distance    = Num $in.distance
                raining     = [bool]$in.raining
                dark        = [bool]$in.dark
                buzzer      = [bool]$in.buzzer
                reason      = Clean $in.reason
                time        = Now
            }
            $json = ConvertTo-Json -InputObject $reading -Compress
            $script:latestJson = $json
            $script:history.Add($json)
            if ($script:history.Count -gt $historySize) { $script:history.RemoveRange(0, $script:history.Count - $historySize) }
            $script:dirty = $true
            SendJsonText $stream 200 ('{"ok":true,"buzzer":"' + $script:buzzer + '","beep":' + $script:beep + '}')
            Broadcast
            Write-Host "$(Get-Date -f HH:mm:ss)  reading -> $($script:sseClients.Count) dashboard(s): $body" -ForegroundColor Green
            return
        }
        return SendJsonText $stream 200 (StateJson ($query -match '(^|&)history'))
    }

    if ($path -eq '/buzzer.php') {
        if ($method -ne 'POST') { return SendJson $stream 405 @{ error = 'POST only' } }
        $req = try { ConvertFrom-Json -InputObject $body } catch { $null }
        if ($req.action -eq 'beep') {
            $script:beep++
            Write-Host "$(Get-Date -f HH:mm:ss)  clap from website -> beep #$($script:beep)" -ForegroundColor Magenta
        } else {
            $mode = $req.mode
            if (@('auto', 'on', 'off') -notcontains $mode) { return SendJson $stream 400 @{ error = 'mode must be auto, on or off' } }
            $script:buzzer = $mode
            Write-Host "$(Get-Date -f HH:mm:ss)  buzzer mode set to $mode" -ForegroundColor Cyan
        }
        Set-Content -Encoding UTF8 $controlFile (ControlJson)
        SendJsonText $stream 200 ('{"ok":true,' + (ControlJson).Substring(1))
        Broadcast
        return
    }

    # static files (never the data folder or server code)
    if ($path -eq '/') { $path = '/index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root $path.TrimStart('/')))
    $ext = [IO.Path]::GetExtension($file).ToLower()
    if (-not $file.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or $file.StartsWith($dataDir, [StringComparison]::OrdinalIgnoreCase) `
        -or -not $types.ContainsKey($ext) -or -not (Test-Path -PathType Leaf $file)) {
        return Send $stream 404 'text/plain' ([Text.Encoding]::ASCII.GetBytes('Not found'))
    }
    Send $stream 200 $types[$ext] ([IO.File]::ReadAllBytes($file))
}

# Listen on IPv6 + IPv4 so "localhost" connects instantly
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::IPv6Any, $Port)
$listener.Server.DualMode = $true
try { $listener.Start() } catch {
    Write-Host "Port $Port is already in use. Is the server already running in another window?" -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}

$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
Write-Host ''
Write-Host '  IoT Weather Station - local server is running (live push enabled)' -ForegroundColor Green
Write-Host "  Dashboard on this PC : http://localhost:$Port/"
foreach ($ip in $ips) {
    Write-Host "  ESP32 SERVER_URL     : http://$($ip.IPAddress):$Port/data.php   ($($ip.InterfaceAlias))" -ForegroundColor Yellow
}
Write-Host '  Stop with Ctrl+C or close this window.'
Write-Host ''

$lastBeat = Get-Date
$lastSave = Get-Date
try {
    while ($true) {
        if ($listener.Pending()) {
            $client = $listener.AcceptTcpClient()
            $client.NoDelay = $true
            $keep = $false
            try { $keep = (Handle $client) -contains 'keep' }
            catch { Write-Host "error: $_" -ForegroundColor Red }
            finally { if (-not $keep) { $client.Close() } }
            continue
        }
        $now = Get-Date
        # keep dashboards' "online/offline" status fresh even when no readings arrive
        if (($now - $lastBeat).TotalSeconds -ge 5) { $lastBeat = $now; Broadcast }
        if ($dirty -and ($now - $lastSave).TotalSeconds -ge 10) { $lastSave = $now; $dirty = $false; SaveData }
        Start-Sleep -Milliseconds 5
    }
} finally {
    if ($dirty) { SaveData }
    foreach ($c in $sseClients) { $c.Close() }
    $listener.Stop()
}
