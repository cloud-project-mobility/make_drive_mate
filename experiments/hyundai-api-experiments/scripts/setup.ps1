$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
# All changes are confined to this PowerShell process.
Remove-Item Env:VIRTUAL_ENV, Env:CONDA_PREFIX, Env:UV_PROJECT_ENVIRONMENT -ErrorAction SilentlyContinue
$env:UV_PROJECT_ENVIRONMENT = Join-Path $projectRoot '.venv'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $projectRoot '.python-runtime'
$env:UV_CACHE_DIR = Join-Path $projectRoot '.uv-cache'
$env:UV_PYTHON_INSTALL_BIN = 'false'
$env:UV_NO_MODIFY_PATH = '1'
uv python install 3.11 --no-config
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
uv sync --locked
exit $LASTEXITCODE
