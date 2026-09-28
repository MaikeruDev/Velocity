#!/usr/bin/env bash
# levels:check gegen Momentum-Varianten (Patch prozessweit). Ausgabe: shots/v2/momentum/levels-<name>.txt
# Nutzung: bash tools/critique/v2/momentum/levels-variants.sh [name ...]
cd "$(dirname "$0")/../../../.."
run() {
  local name="$1"; shift
  echo "== $name"
  env "$@" npx tsx --import ./tools/critique/v2/momentum/patch.ts tools/validate-levels.ts > "shots/v2/momentum/levels-$name.txt" 2>&1
  tail -1 "shots/v2/momentum/levels-$name.txt"
}
want() { [ ${#SEL[@]} -eq 0 ] && return 0; for w in "${SEL[@]}"; do [ "$w" = "$1" ] && return 0; done; return 1; }
SEL=("$@")
want slope && run slope MOM=slope
want grace8 && run grace8 MOM=grace MOM_GRACE_TICKS=8
want kickjump05 && run kickjump05 MOM=kickjump MOM_KICKJ_K=0.5
want kickjump1 && run kickjump1 MOM=kickjump,kicker MOM_KICKJ_K=1 MOM_KICK_K=1
want surfw && run surfw MOM=surfw
want cap40 && run cap40 'MOM_CFG={"airSpeedCapLow":40}'
want combo && run combo MOM=slope,grace,kickjump MOM_GRACE_TICKS=8 MOM_KICKJ_K=0.5

want slopedir && run slopedir MOM=slope MOM_SLOPE_DIR=1
want slope05dir && run slope05dir MOM=slope MOM_SLOPE_DIR=1 MOM_SLOPE_K=0.5
want combodir && run combodir MOM=slope,grace,kickjump MOM_SLOPE_DIR=1 MOM_GRACE_TICKS=8 MOM_KICKJ_K=0.5
want grace12 && run grace12 MOM=grace MOM_GRACE_TICKS=12

want slopeslide && run slopeslide MOM=slope MOM_SLOPE_DIR=1 MOM_SLOPE_SLIDE=1
want combo2 && run combo2 MOM=slope,grace MOM_SLOPE_DIR=1 MOM_SLOPE_SLIDE=1 MOM_GRACE_TICKS=8
want combo3 && run combo3 MOM=slope,grace MOM_SLOPE_DIR=1 MOM_SLOPE_SLIDE=1 MOM_GRACE_TICKS=8 'MOM_CFG={"airSpeedCapLow":40}'

want slopegain && run slopegain MOM=slope MOM_SLOPE_DIR=1 MOM_SLOPE_UP=source
want slopekeep && run slopekeep MOM=slope MOM_SLOPE_DIR=1 MOM_SLOPE_K=0
want slope30 && run slope30 MOM=slope MOM_SLOPE_DIR=1 MOM_SLOPE_SLIDE=1 MOM_SLOPE_MAXDEG=30
exit 0
