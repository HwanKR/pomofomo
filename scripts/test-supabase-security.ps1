$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$harnessRoot = Join-Path $projectRoot 'test-harness'
$fixturePath = Join-Path $projectRoot 'supabase\tests\fixtures\security_base.sql'
$baseMigrationPath = Join-Path $projectRoot 'supabase\migrations\20260807001129_harden_authorization_and_push_webhook.sql'
# Historical migrations before this baseline cannot be replayed together. Every
# timestamped migration after it is forward-only and must be tested, including
# group deletion, long-term tasks, their privilege correction, and account cleanup.
$baseMigrationName = Split-Path -Leaf $baseMigrationPath
$migrationPaths = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'supabase\migrations') -File |
    Where-Object { $_.Name -match '^\d{14}_.+\.sql$' -and $_.Name -gt $baseMigrationName } |
    Sort-Object Name | Select-Object -ExpandProperty FullName)
$testPaths = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'supabase\tests') -Filter '*.test.sql' -File |
    Sort-Object Name | Select-Object -ExpandProperty FullName)
$preflightPath = Join-Path $projectRoot 'supabase\verification\security_preflight.sql'
$postflightPath = Join-Path $projectRoot 'supabase\verification\security_postflight.sql'
$excludedServices = 'gotrue,realtime,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor'
$databaseContainer = 'supabase_db_fomopomo-security-test'
$harnessConfig = Get-Content -Raw -LiteralPath (Join-Path $harnessRoot 'supabase\config.toml')
if ($harnessConfig -notmatch '(?m)^project_id\s*=\s*"fomopomo-security-test"\s*$') {
    throw 'Refusing to reset a database outside the fomopomo-security-test harness.'
}
if ($migrationPaths.Count -eq 0 -or $testPaths.Count -eq 0) {
    throw 'The security harness requires forward migrations and database tests.'
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,
        [switch]$SuppressOutput
    )

    if ($SuppressOutput) {
        & npx @Arguments | Out-Null
    }
    else {
        & npx @Arguments
    }

    if ($LASTEXITCODE -ne 0) {
        throw "Command failed: npx $($Arguments -join ' ')"
    }
}

function Invoke-LocalSqlFile {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    Get-Content -Raw -LiteralPath $Path |
        & docker exec --interactive $databaseContainer psql `
            --username postgres `
            --dbname postgres `
            --set ON_ERROR_STOP=1

    if ($LASTEXITCODE -ne 0) {
        throw "Local SQL apply failed: $Path"
    }
}

Push-Location $projectRoot
try {
    Invoke-CheckedCommand -SuppressOutput -Arguments @(
        'supabase', '--workdir', $harnessRoot, 'start',
        '--exclude', $excludedServices
    )

    Invoke-CheckedCommand -Arguments @(
        'supabase', '--workdir', $harnessRoot, 'db', 'reset', '--local',
        '--sql-paths', $fixturePath,
        '--sql-paths', $baseMigrationPath
    )

    Invoke-CheckedCommand -SuppressOutput -Arguments @(
        'supabase', '--workdir', $harnessRoot, 'db', 'query', '--local',
        '--file', $preflightPath
    )
    Write-Output 'Read-only preflight query: PASS'

    foreach ($path in $migrationPaths) {
        Invoke-LocalSqlFile -Path $path
        Write-Output "Forward-only migration apply: PASS ($(Split-Path -Leaf $path))"
    }

    Invoke-CheckedCommand -Arguments (@(
        'supabase', '--workdir', $harnessRoot, 'test', 'db', '--local'
    ) + $testPaths)

    Invoke-CheckedCommand -SuppressOutput -Arguments @(
        'supabase', '--workdir', $harnessRoot, 'db', 'query', '--local',
        '--file', $postflightPath
    )
    Write-Output 'Read-only postflight checks: PASS'

    Invoke-CheckedCommand -Arguments @(
        'supabase', '--workdir', $harnessRoot, 'db', 'lint', '--local',
        '--schema', 'public,private', '--level', 'warning',
        '--fail-on', 'error'
    )

    Invoke-CheckedCommand -Arguments @(
        'supabase', '--workdir', $harnessRoot, 'db', 'advisors', '--local',
        '--type', 'security', '--fail-on', 'error'
    )
}
finally {
    Pop-Location
}
