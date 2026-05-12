# ============================================================
#  MiCC → Dialed In Dash  |  Real-Time Queue Stats Poller
#  Run on the office PC.  Queries MiCC SQL Server every 5s
#  and pushes queue hold times to JSONBin so the dash updates
#  within ~10s of real-world changes.
#
#  Setup:
#    1. Edit the CONFIGURATION block below (SQL server/db/auth)
#    2. Test: run manually in PowerShell, confirm "Pushed X queues"
#    3. Autostart: import the Task Scheduler block at the bottom
# ============================================================

# ─── CONFIGURATION ───────────────────────────────────────────
$SqlServer    = "localhost\SQLEXPRESS"          # ← MiCC SQL Server instance name
$Database     = "MICC"                          # ← MiCC database name
$UseWinAuth   = $true                           # $true = Windows Auth  |  $false = SQL login
$SqlUser      = ""                              # only needed if $UseWinAuth = $false
$SqlPass      = ""                              # only needed if $UseWinAuth = $false

$JsonBinKey   = '$2a$10$FGPByEJ4blWG1s4Yd7xbbeLrLw0N1LEHuLehI9C/bNChGCV6839Wa'
$JsonBinId    = '6a024774250b1311c336ef6d'
$PollSeconds  = 5
# ─────────────────────────────────────────────────────────────

# Real-time queue query for MiCC.
# Pulls: queue name, callers currently waiting, longest current hold (seconds),
# and total calls answered today.
#
# If this errors, open SSMS and run:
#   SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE '%queue%' OR TABLE_NAME LIKE '%Queue%'
# to find the right table names for your MiCC version, then adjust below.
$Query = @"
SELECT
    q.QueueID                           AS id,
    q.QueueName                         AS name,
    ISNULL(rt.CallsWaiting,     0)      AS waiting,
    ISNULL(rt.LongestWaitTime,  0)      AS longestWait,
    ISNULL(rt.CallsAnsweredToday, 0)    AS answered
FROM dbo.Queue q
LEFT JOIN dbo.rtQueueStats rt ON rt.QueueID = q.QueueID
WHERE q.Active = 1
  AND q.QueueName NOT LIKE '%test%'
ORDER BY q.QueueName
"@

# ── connection string ─────────────────────────────────────────
function Get-ConnString {
    if ($UseWinAuth) {
        return "Server=$SqlServer;Database=$Database;Integrated Security=True;Connect Timeout=5;"
    } else {
        return "Server=$SqlServer;Database=$Database;User Id=$SqlUser;Password=$SqlPass;Connect Timeout=5;"
    }
}

# ── query SQL Server ──────────────────────────────────────────
function Get-QueueStats {
    $conn = New-Object System.Data.SqlClient.SqlConnection (Get-ConnString)
    $conn.Open()
    $cmd                = $conn.CreateCommand()
    $cmd.CommandText    = $Query
    $cmd.CommandTimeout = 5
    $adapter            = New-Object System.Data.SqlClient.SqlDataAdapter $cmd
    $table              = New-Object System.Data.DataTable
    $adapter.Fill($table) | Out-Null
    $conn.Close()
    return $table
}

# ── push to JSONBin ───────────────────────────────────────────
function Push-ToJsonBin ($json) {
    $uri     = "https://api.jsonbin.io/v3/b/$JsonBinId"
    $headers = @{
        'X-Master-Key' = $JsonBinKey
        'Content-Type' = 'application/json'
    }
    Invoke-RestMethod -Uri $uri -Method Put -Headers $headers -Body $json -ErrorAction Stop | Out-Null
}

# ── main loop ─────────────────────────────────────────────────
Write-Host "MiCC queue poller started — polling every ${PollSeconds}s.  Ctrl+C to stop." -ForegroundColor Cyan

while ($true) {
    try {
        $table  = Get-QueueStats
        $queues = foreach ($row in $table.Rows) {
            [PSCustomObject]@{
                id           = [string]$row["id"]
                name         = [string]$row["name"]
                waiting      = [int]$row["waiting"]
                longestWait  = if ($row["longestWait"]  -is [DBNull]) { $null } else { [int]$row["longestWait"] }
                answered     = if ($row["answered"]     -is [DBNull]) { 0      } else { [int]$row["answered"]   }
            }
        }

        $payload = [PSCustomObject]@{
            updatedAt = (Get-Date).ToUniversalTime().ToString("o")
            queues    = @($queues)
        } | ConvertTo-Json -Depth 3 -Compress

        Push-ToJsonBin $payload

        $summary = ($queues | ForEach-Object { "$($_.name): $($_.waiting) waiting / $($_.longestWait)s hold" }) -join "  |  "
        Write-Host "$(Get-Date -Format 'HH:mm:ss')  ✓  $summary" -ForegroundColor Green
    }
    catch [System.Data.SqlClient.SqlException] {
        Write-Warning "$(Get-Date -Format 'HH:mm:ss')  SQL error — check server/database name: $($_.Exception.Message)"
        Start-Sleep -Seconds 15   # back off on SQL errors
    }
    catch {
        Write-Warning "$(Get-Date -Format 'HH:mm:ss')  Error: $($_.Exception.Message)"
    }

    Start-Sleep -Seconds $PollSeconds
}

# ============================================================
#  AUTO-START VIA WINDOWS TASK SCHEDULER
#  Run this block ONCE as Administrator to register the task.
#  It will start the poller automatically on login/boot.
#
#  Paste and run in an elevated PowerShell window:
# ============================================================
<#
$scriptPath = "C:\Scripts\micc-queue-poller.ps1"   # ← adjust path where you save this file

$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
               -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
               -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName "MiCC Queue Poller" `
    -Action $action -Trigger $trigger -Settings $settings `
    -Description "Pushes MiCC real-time queue hold times to Dialed In Dash" `
    -RunLevel Highest -Force

Write-Host "Task registered. It will run at next login." -ForegroundColor Green
#>
