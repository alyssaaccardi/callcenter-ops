# ============================================================
#  MiCC → Dialed In Dash  |  Real-Time Queue Stats Poller
#  Calls the MiCC Contact Center REST API every 5s and pushes
#  live queue stats to the dashboard.
#
#  Setup:
#    1. Save this file on the office PC (Desktop\Scripts\)
#    2. Test: & "C:\Users\micro\Desktop\Scripts\micc-queue-poller.ps1"
#    3. Keep the window open — closing it stops the poller
# ============================================================

# ─── CONFIGURATION ───────────────────────────────────────────
$MiccServer   = "http://192.168.1.242"
$MiccUser     = "DianaRicottone"
$MiccPass     = "Savvy1!"

$ServerUrl    = "https://ops.answeringlegal.com/api/mitel/queue-stats"
$PollerSecret = "DialedIn-Mitel-2026-XQ7"
$PollSeconds  = 5

$QueueNames = @{ P862 = "8262"; P861 = "8261"; P803 = "8203" }
# ─────────────────────────────────────────────────────────────

# Skip SSL cert validation for internal server
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$script:Token       = $null
$script:TokenExpiry = [DateTime]::MinValue

function Get-MiccToken {
    $body    = "grant_type=password&username=$([Uri]::EscapeDataString($MiccUser))&password=$([Uri]::EscapeDataString($MiccPass))"
    $headers = @{ 'Content-Type' = 'application/x-www-form-urlencoded' }
    $r = Invoke-RestMethod -Uri "$MiccServer/authorizationserver/token" -Method Post -Headers $headers -Body $body -ErrorAction Stop
    $script:Token       = $r.access_token
    $script:TokenExpiry = (Get-Date).AddSeconds([int]$r.expires_in - 30)
    Write-Host "$(Get-Date -Format 'HH:mm:ss')  Token acquired (expires in $([int]$r.expires_in)s)" -ForegroundColor DarkCyan
}

function Get-QueueState($queueId) {
    if ((Get-Date) -ge $script:TokenExpiry) { Get-MiccToken }
    $headers = @{ 'Authorization' = "Bearer $($script:Token)" }
    return Invoke-RestMethod -Uri "$MiccServer/miccsdk/api/v1/queues/$queueId/state" -Method Get -Headers $headers -ErrorAction Stop
}

function Push-ToServer($json) {
    $headers = @{ 'X-Poller-Secret' = $PollerSecret; 'Content-Type' = 'application/json' }
    Invoke-RestMethod -Uri $ServerUrl -Method Post -Headers $headers -Body $json -ErrorAction Stop | Out-Null
}

Write-Host "MiCC API poller started — polling every ${PollSeconds}s.  Ctrl+C to stop." -ForegroundColor Cyan

# Get initial token
Get-MiccToken

while ($true) {
    try {
        $queues = foreach ($code in $QueueNames.Keys) {
            $state = Get-QueueState $code

            $waiting     = if ($null -ne $state.waitingConversations)               { [int]$state.waitingConversations }               else { 0 }
            $longestWait = if ($state.longestWaitingConversationDuration -gt 0)     { [int]$state.longestWaitingConversationDuration }  else { $null }
            $answered    = if ($null -ne $state.answeredConversationsToday)         { [int]$state.answeredConversationsToday }          else { 0 }
            $avgWait     = if ($state.estimatedWaitTimeForNewConversations -gt 0)   { [int]$state.estimatedWaitTimeForNewConversations } else { $null }

            [PSCustomObject]@{
                id          = $code
                name        = $QueueNames[$code]
                waiting     = $waiting
                longestWait = $longestWait
                answered    = $answered
                avgWait     = $avgWait
            }
        }

        $payload = [PSCustomObject]@{
            updatedAt = (Get-Date).ToUniversalTime().ToString("o")
            queues    = @($queues | Sort-Object name)
        } | ConvertTo-Json -Depth 3 -Compress

        Push-ToServer $payload

        $summary = ($queues | Sort-Object name | ForEach-Object {
            "$($_.name): $($_.waiting) waiting / $(if($_.longestWait){"$($_.longestWait)s"}else{'--'}) hold / $($_.answered) ans"
        }) -join "  |  "
        Write-Host "$(Get-Date -Format 'HH:mm:ss')  $summary" -ForegroundColor Green
    }
    catch {
        Write-Warning "$(Get-Date -Format 'HH:mm:ss')  Error: $($_.Exception.Message)"
        $script:TokenExpiry = [DateTime]::MinValue
    }

    Start-Sleep -Seconds $PollSeconds
}
