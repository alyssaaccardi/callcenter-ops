# Mitel CCM Queue Poller
# Runs on an always-on office PC — no Node.js required, pure PowerShell.
# Queries CCMStatisticalData every 5 seconds and pushes today's queue totals to JSONBin.
#
# How to run:
#   Right-click this file -> Run with PowerShell
#   OR from PowerShell prompt: .\mitel-queue-poller.ps1
#
# To run at startup: Task Scheduler -> Create Basic Task -> Trigger: At startup
#   Program: powershell.exe
#   Arguments: -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\mitel-poller\mitel-queue-poller.ps1"

$MSSQL_SERVER   = "192.168.1.242"
$MSSQL_USER     = "CommandCenterSA"
$MSSQL_PASS     = "T}9]5kqe1!gF"
$MSSQL_DB       = "CCMStatisticalData"
$JSONBIN_KEY    = '$2a$10$FGPByEJ4blWG1s4Yd7xbbeLrLw0N1LEHuLehI9C/bNChGCV6839Wa'
$JSONBIN_BIN_ID = "6a024774250b1311c336ef6d"
$POLL_SECONDS   = 5

$connStr = "Server=$MSSQL_SERVER;Database=$MSSQL_DB;User Id=$MSSQL_USER;Password=$MSSQL_PASS;TrustServerCertificate=True;Encrypt=False;"

$query = @"
SELECT
  Queue,
  SUM(CASE WHEN TimeToAnswer IS NOT NULL THEN 1 ELSE 0 END) AS answered,
  SUM(CASE WHEN TimeToAnswer IS NULL     THEN 1 ELSE 0 END) AS abandoned,
  AVG(CASE WHEN TimeToAnswer > 0 THEN CAST(TimeToAnswer AS float) END) AS avgWait,
  AVG(CASE WHEN Duration     > 0 THEN CAST(Duration     AS float) END) AS avgDuration
FROM [dbo].[tblData_LC_Trace]
WHERE Queue IN ('P862','P861','P803')
  AND PegCount = 1
  AND CallStartTime >= CAST(GETDATE() AS DATE)
GROUP BY Queue
"@

$queueNames = @{ "P862" = "8262"; "P861" = "8261"; "P803" = "8203" }

function Get-Timestamp { return (Get-Date).ToString("HH:mm:ss") }

Write-Host "Mitel queue poller starting..."
Write-Host "  SQL: $MSSQL_SERVER / $MSSQL_DB"
Write-Host "  Bin: $JSONBIN_BIN_ID"
Write-Host "  Poll: every ${POLL_SECONDS}s`n"

while ($true) {
    try {
        # Query SQL
        $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
        $conn.Open()
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $query
        $reader = $cmd.ExecuteReader()

        $rows = @{}
        while ($reader.Read()) {
            $q = $reader["Queue"]
            $rows[$q] = @{
                answered    = [int]$reader["answered"]
                abandoned   = [int]$reader["abandoned"]
                avgWait     = if ($reader["avgWait"] -eq [DBNull]::Value) { $null } else { [int][Math]::Round([double]$reader["avgWait"]) }
                avgDuration = if ($reader["avgDuration"] -eq [DBNull]::Value) { $null } else { [int][Math]::Round([double]$reader["avgDuration"]) }
            }
        }
        $reader.Close()
        $conn.Close()

        # Build payload
        $queues = @()
        foreach ($id in @("P862","P861","P803")) {
            $r = $rows[$id]
            $queues += @{
                id          = $id
                name        = $queueNames[$id]
                answered    = if ($r) { $r.answered }    else { 0 }
                abandoned   = if ($r) { $r.abandoned }   else { 0 }
                avgWait     = if ($r) { $r.avgWait }     else { $null }
                avgDuration = if ($r) { $r.avgDuration } else { $null }
            }
        }

        $payload = @{ queues = $queues; updatedAt = (Get-Date).ToUniversalTime().ToString("o") }
        $body = $payload | ConvertTo-Json -Depth 5 -Compress

        # PUT to JSONBin
        $headers = @{
            "Content-Type" = "application/json"
            "X-Master-Key" = $JSONBIN_KEY
        }
        $response = Invoke-RestMethod -Uri "https://api.jsonbin.io/v3/b/$JSONBIN_BIN_ID" `
            -Method PUT -Headers $headers -Body $body

        $totals = $queues | ForEach-Object { "$($_.name):$($_.answered)ans/$($_.abandoned)abn" }
        Write-Host "$(Get-Timestamp) OK  $($totals -join '  ')"

    } catch {
        Write-Host "$(Get-Timestamp) ERR $($_.Exception.Message)"
    }

    Start-Sleep -Seconds $POLL_SECONDS
}
