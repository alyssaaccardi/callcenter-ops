# ============================================================
#  MiCC → Dialed In Dash  |  Real-Time Queue Stats Poller
#  Run on the office PC (must be on same network as MICCSQL01).
#  Queries CCMData every 5s and pushes to JSONBin so the dash
#  updates in ~10s.
#
#  Setup:
#    1. Save this file on the office PC (e.g. C:\Scripts\micc-queue-poller.ps1)
#    2. Test: powershell -ExecutionPolicy Bypass -File C:\Scripts\micc-queue-poller.ps1
#    3. Auto-start: run the Register-ScheduledTask block at the bottom (as Admin)
# ============================================================

# ─── CONFIGURATION ───────────────────────────────────────────
$SqlServer   = "MICCSQL01\MSSQLSERVER"
$Database    = "CCMData"
$SqlUser     = "CommandCenterSA"
$SqlPass     = 'T}9]5kqe1!gF'

$ServerUrl    = "https://ops.answeringlegal.com/api/mitel/queue-stats"
$PollerSecret = "DialedIn-Mitel-2026-XQ7"
$PollSeconds  = 5

# Queue code → display name mapping
$QueueNames = @{
    P862 = "8262"
    P861 = "8261"
    P803 = "8203"
}
$QueueList = ($QueueNames.Keys | ForEach-Object { "'$_'" }) -join ","
# ─────────────────────────────────────────────────────────────

$ConnString = "Server=$SqlServer;Database=$Database;User Id=$SqlUser;Password=$SqlPass;Connect Timeout=5;"

# Two queries run together:
#  1. Today's totals — answered count + avg wait for answered calls (historical)
#  2. Currently waiting — calls that have NOT been answered yet, started in
#     the last 15 minutes (proxy for "in queue right now")
$QueryTotals = @"
SELECT
    Queue,
    SUM(CASE WHEN TimeToAnswer IS NOT NULL THEN 1 ELSE 0 END)                      AS answered,
    AVG(CASE WHEN TimeToAnswer > 0 THEN CAST(TimeToAnswer AS float) END)            AS avgWait
FROM [dbo].[tblData_LC_Trace]
WHERE Queue IN ($QueueList)
  AND PegCount = 1
  AND CallStartTime >= CAST(GETDATE() AS DATE)
GROUP BY Queue
"@

$QueryWaiting = @"
SELECT
    Queue,
    COUNT(*)                                                                         AS waiting,
    MAX(DATEDIFF(SECOND, CallStartTime, GETDATE()))                                  AS longestWait
FROM [dbo].[tblData_LC_Trace]
WHERE Queue IN ($QueueList)
  AND PegCount = 1
  AND TimeToAnswer IS NULL
  AND CallStartTime >= DATEADD(MINUTE, -15, GETDATE())
GROUP BY Queue
"@

function Invoke-SqlQuery($query) {
    $conn = New-Object System.Data.SqlClient.SqlConnection $ConnString
    $conn.Open()
    $cmd             = $conn.CreateCommand()
    $cmd.CommandText = $query
    $cmd.CommandTimeout = 5
    $adapter         = New-Object System.Data.SqlClient.SqlDataAdapter $cmd
    $table           = New-Object System.Data.DataTable
    $adapter.Fill($table) | Out-Null
    $conn.Close()
    return $table
}

function Push-ToServer($json) {
    $headers = @{ 'X-Poller-Secret' = $PollerSecret; 'Content-Type' = 'application/json' }
    Invoke-RestMethod -Uri $ServerUrl -Method Post -Headers $headers -Body $json -ErrorAction Stop | Out-Null
}

Write-Host "MiCC queue poller started — polling every ${PollSeconds}s.  Ctrl+C to stop." -ForegroundColor Cyan

while ($true) {
    try {
        $totals  = Invoke-SqlQuery $QueryTotals
        $waiting = Invoke-SqlQuery $QueryWaiting

        # Index waiting data by queue code for easy lookup
        $waitIdx = @{}
        foreach ($row in $waiting.Rows) { $waitIdx[$row["Queue"]] = $row }

        $queues = foreach ($code in $QueueNames.Keys) {
            $tot = $totals.Rows | Where-Object { $_["Queue"] -eq $code } | Select-Object -First 1
            $wt  = $waitIdx[$code]

            [PSCustomObject]@{
                id          = $code
                name        = $QueueNames[$code]
                waiting     = if ($wt)  { [int]$wt["waiting"] }     else { 0 }
                longestWait = if ($wt -and $wt["longestWait"] -isnot [DBNull]) { [int]$wt["longestWait"] } else { $null }
                answered    = if ($tot -and $tot["answered"]  -isnot [DBNull]) { [int]$tot["answered"]   } else { 0 }
                avgWait     = if ($tot -and $tot["avgWait"]   -isnot [DBNull]) { [int]$tot["avgWait"]    } else { $null }
            }
        }

        $payload = [PSCustomObject]@{
            updatedAt = (Get-Date).ToUniversalTime().ToString("o")
            queues    = @($queues | Sort-Object name)
        } | ConvertTo-Json -Depth 3 -Compress

        Push-ToServer $payload

        $summary = ($queues | Sort-Object name | ForEach-Object {
            "$($_.name): $($_.waiting) waiting / $(if($_.longestWait){"$($_.longestWait)s"}else{'—'}) hold / $($_.answered) ans"
        }) -join "  |  "
        Write-Host "$(Get-Date -Format 'HH:mm:ss')  $summary" -ForegroundColor Green
    }
    catch [System.Data.SqlClient.SqlException] {
        Write-Warning "$(Get-Date -Format 'HH:mm:ss')  SQL error: $($_.Exception.Message)"
        Start-Sleep -Seconds 15
    }
    catch {
        Write-Warning "$(Get-Date -Format 'HH:mm:ss')  Error: $($_.Exception.Message)"
    }

    Start-Sleep -Seconds $PollSeconds
}

# ============================================================
#  AUTO-START (run once as Administrator)
# ============================================================
<#
$scriptPath = "C:\Scripts\micc-queue-poller.ps1"

$action   = New-ScheduledTaskAction -Execute "powershell.exe" `
                -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 5 `
                -RestartInterval (New-TimeSpan -Minutes 1) `
                -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName "MiCC Queue Poller" `
    -Action $action -Trigger $trigger -Settings $settings `
    -Description "Pushes MiCC real-time queue hold times to Dialed In Dash" `
    -RunLevel Highest -Force

Write-Host "Task registered — runs automatically at next login." -ForegroundColor Green
#>
