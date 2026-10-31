#!/usr/bin/env bash
# Install the assembled Linux payload into the user's XDG data directory.
# No root required; no system Python or Node is needed at runtime.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PAYLOAD_SRC="${MAIBOT_PAYLOAD_SRC:-$REPO_ROOT/payload}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
INSTALL_DIR="$DATA_HOME/maibot-onekey/payload"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"

if [ ! -d "$PAYLOAD_SRC/runtime/python" ]; then
  echo "payload 未组装。先运行: bun run payload:linux" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$BIN_DIR"
echo "安装 payload: $PAYLOAD_SRC -> $INSTALL_DIR"
cp -a "$PAYLOAD_SRC/." "$INSTALL_DIR/"

NODE_BIN="$INSTALL_DIR/runtime/python/bin/python3"  # placeholder replaced below
CLI_NODE=""
for candidate in "$INSTALL_DIR/runtime/node/bin/node" "$(command -v node || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then CLI_NODE="$candidate"; break; fi
done
if [ -z "$CLI_NODE" ]; then
  echo "未找到 node (>=24.22.1)。安装 Node 24 LTS 或设置 MAIBOT_ONEKEY_NODE。" >&2
  exit 1
fi

cat > "$BIN_DIR/maibot-ok" <<LAUNCHER
#!/usr/bin/env bash
exec "$CLI_NODE" "$INSTALL_DIR/cli/maibot-ok.mjs" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/maibot-ok"
echo "安装完成: $BIN_DIR/maibot-ok"
echo "验证: maibot-ok doctor"
