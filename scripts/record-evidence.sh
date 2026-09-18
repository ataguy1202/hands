#!/bin/sh
# Regenerates every replay run under evidence/ from the two saved capabilities.
# Discovery runs are not touched (they need a model key); everything here is deterministic.
# Usage: scripts/record-evidence.sh   (starts and stops the target itself; needs port 4100 and 4700 free)
set -eu
cd "$(dirname "$0")/.."
npx tsx target/server.ts > /dev/null 2>&1 & TARGET=$!
trap 'kill $TARGET 2>/dev/null || true; pkill -f "scripts/operator.ts" 2>/dev/null || true' EXIT
sleep 2
fault() { curl -s -X POST localhost:4100/__faults -d "$1" > /dev/null; }
clear_faults() { curl -s -X DELETE localhost:4100/__faults > /dev/null; }
operator() { npx tsx scripts/operator.ts "$@" > /dev/null 2>&1 & sleep 1; }
stop_operator() { pkill -f "scripts/operator.ts" 2>/dev/null || true; sleep 0.5; }

rm -rf evidence/replay-*
L=lookup_member_savings_balance
O=open_holiday_club_sub_account

bin/hands replay $L --input memberId=10042 --label verify
bin/hands replay $L --input memberId=10077 --label success
bin/hands replay $L --input memberId=99999 --label not-found
bin/hands replay $L --input memberId=abc   --label bad-input || true
fault '{"expireSession":true}';   bin/hands replay $L --input memberId=20015 --label session-expired
fault '{"appErrorOnce":true}';    bin/hands replay $L --input memberId=10042 --label app-error
fault '{"slowMs":1500}';          bin/hands replay $L --input memberId=10077 --label slow-core; clear_faults
fault '{"complianceDialog":true}'; operator attest --once; bin/hands replay $L --input memberId=10042 --label escalation; clear_faults; stop_operator
bin/hands stability $L --n 3 --input memberId=10077 || true
bin/hands invoke $L --args '{"memberId":"20015"}' > /dev/null

operator approve
bin/hands replay $O --input memberId=10077 --input nickname=Vacation --input initialDeposit=25.00 --label verify
bin/hands replay $O --input memberId=10042 --input nickname=Trip --input initialDeposit=40.00 --label success
bin/hands replay $O --input memberId=10042 --input nickname=Tiny --input initialDeposit=2.00 --label below-minimum
stop_operator
operator deny --once;  bin/hands replay $O --input memberId=10042 --input nickname=Nope --input initialDeposit=10.00 --label denied || true; stop_operator
operator supervisor --pin 2468; bin/hands replay $O --input memberId=40001 --input nickname=Override --input initialDeposit=15.00 --label supervisor; stop_operator

npx tsx scripts/evidence-index.ts
