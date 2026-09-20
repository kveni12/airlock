#!/usr/bin/env bash
# Runs inside the disposable workspace as the run's primary process, so output
# reaches the existing event collector. Never print credential values.
set -u
failures=0
pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }

printf 'Permission probes for the default demo scope (not a security certification)\n'
for required in src/greeting.js tests/greeting.test.js infra/prod.tf package.json; do
  if [ ! -r "$required" ]; then
    printf 'FAIL fixture missing or unreadable: %s. Check Docker host file sharing and AGENTGUARD_WORKSPACE_ROOT.\n' "$required"
    exit 2
  fi
done
if printf 'demo\n' > src/permission-probe.txt; then pass 'write inside src'; else fail 'write inside src'; fi
if printf 'demo\n' > tests/permission-probe.txt; then pass 'write inside tests'; else fail 'write inside tests'; fi
if cat infra/prod.tf >/dev/null; then pass 'read infra'; else fail 'read infra'; fi
if (printf '# forbidden\n' >> infra/prod.tf); then fail 'infra write was allowed'; else pass 'infra write blocked'; fi
if (printf '\n' >> package.json); then fail 'package.json write was allowed'; else pass 'package.json write blocked'; fi
if touch unexpected-root-file; then fail 'root write was allowed'; else pass 'root write blocked'; fi
if rm infra/prod.tf; then fail 'infra deletion was allowed'; else pass 'infra deletion blocked'; fi
if [ "${PERISCOPE_DEMO_GRANTED:-}" = 'demo-only-granted' ]; then pass 'granted dummy secret injected'; else fail 'granted dummy secret missing (export it on the backend)'; fi
if [ -z "${PERISCOPE_DEMO_DENIED+x}" ]; then pass 'ungranted dummy secret absent'; else fail 'ungranted dummy secret leaked'; fi
if node tests/greeting.test.js; then pass 'project tests'; else fail 'project tests'; fi

# A failed connection is NOT proof of a working allowlist. Require the proxy's
# actual 403 denial, plus a successful allowed-host connection as a control.
blocked=$(curl -sS --max-time 8 -o /tmp/periscope-blocked-body -w '%{http_code}' http://example.com/ || true)
if [ "$blocked" = 403 ] && grep -q 'Blocked by Periscope' /tmp/periscope-blocked-body; then
  pass 'proxy explicitly denied example.com'
else
  fail "expected proxy denial, got HTTP $blocked (check proxy reachability)"
fi
allowed=$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' https://api.openai.com/v1/models || true)
# Deliberately send no API key. A 401 proves transport to the allowed service.
if [ "$allowed" = 401 ]; then pass 'allowed API host reachable (unauthenticated 401)'; else fail "allowed API host returned $allowed, expected 401"; fi

# Use a literal public IP: DNS failure must not masquerade as socket isolation.
if node -e 'const net=require("net");const s=net.connect(443,"1.1.1.1");s.setTimeout(3000);s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));s.on("timeout",()=>{s.destroy();process.exit(1)})'; then
  fail 'direct external TCP connection bypassed proxy'
else
  pass 'direct external TCP probe could not connect'
fi
printf '\nFailures: %s\n' "$failures"
exit "$((failures > 0))"
