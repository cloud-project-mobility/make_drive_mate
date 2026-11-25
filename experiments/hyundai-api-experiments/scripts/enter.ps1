# Dot-source this in each new terminal to select this project's local environment.
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
Remove-Item Env:VIRTUAL_ENV, Env:CONDA_PREFIX, Env:UV_PROJECT_ENVIRONMENT -ErrorAction SilentlyContinue
$env:UV_PROJECT_ENVIRONMENT = Join-Path $projectRoot '.venv'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $projectRoot '.python-runtime'
$env:UV_CACHE_DIR = Join-Path $projectRoot '.uv-cache'
$env:UV_PYTHON_INSTALL_BIN = 'false'
$env:UV_NO_MODIFY_PATH = '1'
