#!/usr/bin/env bash
# figma-clipboard-mcp 端到端测试
set -e
cd "$(dirname "$0")"
PORT=8399
kill_port() {
  powershell -NoProfile -Command "
    Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      ForEach-Object { Stop-Process -Id \$_ -Force -ErrorAction SilentlyContinue }
  " >/dev/null 2>&1 || true
  sleep 0.6
}
start_server() {  # $1 = extra env
  node lib/server.mjs > /tmp/fcm-test-server.log 2>&1 &
  SERVER_PID=$!
  sleep 1.2
}

echo "=== 测试 1：无认证服务 ==="
kill_port
FCM_PORT=$PORT start_server
curl -s -o /dev/null -w "  /                → %{http_code} (期望 200)\n" "http://127.0.0.1:$PORT/"
curl -s -o /dev/null -w "  /index.html      → %{http_code} (期望 200)\n" "http://127.0.0.1:$PORT/index.html"
curl -s -o /dev/null -w "  /vendor/kiwi.js  → %{http_code} (期望 200)\n" "http://127.0.0.1:$PORT/vendor/kiwi.js"
curl -s -o /dev/null -w "  路径穿越攻击      → %{http_code} (期望 404)\n" "http://127.0.0.1:$PORT/%2e%2e/package.json"
curl -s -o /dev/null -w "  /api/health      → %{http_code} (期望 200)\n" "http://127.0.0.1:$PORT/api/health"
kill $SERVER_PID 2>/dev/null || true

echo "=== 测试 2：Basic Auth ==="
kill_port
FCM_PORT=$PORT FCM_USER=admin FCM_PASS=secret123 start_server
curl -s -o /dev/null -w "  无凭据           → %{http_code} (期望 401)\n" "http://127.0.0.1:$PORT/"
curl -s -o /dev/null -w "  错误密码         → %{http_code} (期望 401)\n" -u admin:wrong "http://127.0.0.1:$PORT/"
curl -s -o /dev/null -w "  正确凭据         → %{http_code} (期望 200)\n" -u admin:secret123 "http://127.0.0.1:$PORT/"
curl -s -o /dev/null -w "  健康检查(免认证)  → %{http_code} (期望 200)\n" "http://127.0.0.1:$PORT/api/health"
R=$(curl -s -u admin:secret123 -X POST "http://127.0.0.1:$PORT/mcp" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"ping"}')
echo "  MCP 带凭据 ping  → $R (期望含 result)"
kill $SERVER_PID 2>/dev/null || true

echo "=== 测试 3：缓存生命周期 ==="
kill_port
FCM_PORT=$PORT start_server
curl -s -X POST "http://127.0.0.1:$PORT/cache" -H "Content-Type: application/json" \
  -d '{"meta":{"fileKey":"t1"},"nodes":[{"guid":"1:1","parent":null,"type":"DOCUMENT","name":"A","visible":true}]}' >/dev/null
INFO=$(curl -s "http://127.0.0.1:$PORT/api/cache-info")
echo "  写入后: $INFO"
kill $SERVER_PID 2>/dev/null || true
# 重启后应从磁盘恢复
kill_port
FCM_PORT=$PORT start_server
INFO=$(curl -s "http://127.0.0.1:$PORT/api/cache-info")
echo "  重启后: $INFO (期望 hasData:true 持久化生效)"
kill $SERVER_PID 2>/dev/null || true
kill_port
echo "=== 全部完成 ==="
