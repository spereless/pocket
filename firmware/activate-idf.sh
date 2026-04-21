# Activate ESP-IDF for this shell.
# Usage:  source firmware/activate-idf.sh
#
# Why the shim: ESP-IDF v5.3's detect_python.sh picks whatever "python3" is
# first on PATH. macOS ships a system Python 3.9, which is too old — its
# importlib.metadata chokes on the legacy dotted package name ruamel.yaml.clib
# during IDF's dep check. We front-run PATH with ~/.idfshim/python3 → python3.12
# so IDF uses a modern interpreter without us touching system Python.

export PATH="$HOME/.idfshim:$PATH"

IDF_DIR="$HOME/esp/esp-idf"
if [ ! -f "$IDF_DIR/export.sh" ]; then
    echo "ESP-IDF not found at $IDF_DIR — run the bootstrap install first." >&2
    return 1 2>/dev/null || exit 1
fi

# shellcheck disable=SC1091
. "$IDF_DIR/export.sh"
