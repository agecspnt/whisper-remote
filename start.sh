#!/bin/bash
# whisper-remote launcher
# Ubuntu 18.04 needs PortAudio from conda env

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONDA_ENV_LIB="/home/zhe/anaconda3/envs/whisper-remote/lib"

export LD_LIBRARY_PATH="$CONDA_ENV_LIB:$LD_LIBRARY_PATH"

cd "$SCRIPT_DIR"
exec uv run python main.py "$@"
