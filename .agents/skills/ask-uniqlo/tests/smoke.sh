#!/usr/bin/env bash
# Live checks against www.uniqlo.com/kr. Run manually; needs network.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UQ=(node "${DIR}/scripts/uq.mjs")
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }
# js '<arrow fn>' — apply a JS function to the JSON on stdin and print the result.
js() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(eval(process.argv[1])(JSON.parse(s))))' "$1"; }

n=$("${UQ[@]}" search 후리스 --limit 5 | js 'o=>o.items.length'); [ "$n" -ge 1 ] && pass "search ($n items)" || fail "search"
w=$("${UQ[@]}" search 후리스 --gender men --limit 40 | js 'o=>o.items.filter(i=>i.gender==="WOMEN").length'); [ "$w" -eq 0 ] && pass "gender filter" || fail "gender filter: $w WOMEN rows"
g=$("${UQ[@]}" search 청바지 --limit 40 | js 'o=>o.items.filter(i=>/^GU/.test(i.name)).length'); [ "$g" -eq 0 ] && pass "GU excluded" || fail "GU excluded: $g GU rows"
detail=$("${UQ[@]}" detail E450195-000)
m=$(echo "$detail" | js 'o=>Object.keys(o.sizeChart?.garment??{}).length'); [ "$m" -ge 3 ] && pass "detail size chart ($m sizes)" || fail "detail size chart"
s=$(echo "$detail" | js 'o=>Object.keys(o.priceGroups[0].stock).length'); [ "$s" -ge 1 ] && pass "detail stock ($s colors)" || fail "detail stock"
r=$("${UQ[@]}" reviews E450195-000 --limit 5 | js 'o=>o.items.length'); [ "$r" -ge 1 ] && pass "reviews ($r rows)" || fail "reviews"
md=$("${UQ[@]}" detail E481004-000 --pg 00 | js 'o=>{const g=o.priceGroups[0];return g.originalPrice>g.price&&g.discounted&&!!g.markdownSince}')
[ "$md" = true ] && pass "detail markdown original price" || fail "detail markdown original price (E481004-000 may no longer be marked down)"
sale=$("${UQ[@]}" search 셔츠 --sale --limit 40 | js 'o=>o.items.length>0&&o.items.every(i=>i.discounted)'); [ "$sale" = true ] && pass "search --sale" || fail "search --sale"
lo=$("${UQ[@]}" search 크루넥T --sale --limit 100 | js 'o=>o.items.filter(i=>i.limitedOffer).every(i=>i.limitedOffer.from&&i.limitedOffer.until)'); [ "$lo" = true ] && pass "search --sale limited-offer periods" || fail "search --sale limited-offer periods"
set +e; "${UQ[@]}" detail E999999-000 >/dev/null 2>&1; code=$?; set -e
[ "$code" -eq 4 ] && pass "missing product exits 4" || fail "missing product exit $code"
set +e; "${UQ[@]}" search 존재하지않는검색어zzqx >/dev/null 2>&1; code=$?; set -e
[ "$code" -eq 3 ] && pass "zero results exits 3" || fail "zero results exit $code"
echo "All smoke checks passed."
