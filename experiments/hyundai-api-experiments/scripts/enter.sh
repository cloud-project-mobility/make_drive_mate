# Source this file in each WSL/Linux shell: source scripts/enter.sh
task_project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
unset VIRTUAL_ENV CONDA_PREFIX
export UV_PROJECT_ENVIRONMENT="$task_project_root/.venv"
export UV_PYTHON_INSTALL_DIR="$task_project_root/.python-runtime"
export UV_CACHE_DIR="$task_project_root/.uv-cache"
export UV_PYTHON_INSTALL_BIN=false
export UV_NO_MODIFY_PATH=1
export PATH="$task_project_root/.tools:$PATH"
unset task_project_root
