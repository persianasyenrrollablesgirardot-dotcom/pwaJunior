#!/usr/bin/env bash
# Sincroniza cambios de Visor_PG al repo pwaJunior_repo + commit + push.
# Vercel auto-deploya en cada push a main. Total: ~1 min.
#
# Uso (desde C:\Proyectos\Visor_PG):
#   bash sync-pwa.sh "descripción del cambio"
#
# Ej: bash sync-pwa.sh "fix loop de Junior en respuesta vaga"

set -e
MSG="${1:-sync: cambios desde Visor_PG}"
SRC="/c/Proyectos/Visor_PG"
DST="/c/Proyectos/pwaJunior_repo"

echo "→ Sincronizando archivos clave del Junior..."
cp -r "$SRC/agentes/sintesis/"*.ts "$DST/agentes/sintesis/"
cp "$SRC/visor/src/panels/Junior.tsx"             "$DST/visor/src/panels/"
# JuniorChat.tsx EXCLUIDO a propósito: la versión PWA tiene lógica de auth
# (token + prompt 401) que la versión Visor_PG no tiene. Si cambiás algo del chat
# (mensajes, UI, persistencia), editalo a mano en pwaJunior_repo también.
cp "$SRC/visor/src/panels/JuniorChecklist.tsx"    "$DST/visor/src/panels/"
cp "$SRC/visor/src/panels/JuniorAgendamientos.tsx" "$DST/visor/src/panels/"
cp "$SRC/visor/src/panels/JuniorTareas.tsx"       "$DST/visor/src/panels/"
cp "$SRC/visor/src/lib/linkify.tsx"               "$DST/visor/src/lib/"
cp "$SRC/visor/src/lib/queries.ts"                "$DST/visor/src/lib/"
echo "  ✓ files copiados"

cd "$DST"
if git diff --quiet && git diff --cached --quiet; then
  echo "  → sin cambios nuevos respecto al repo PWA. Nada que pushear."
  exit 0
fi

echo "→ Commit + push..."
git -c user.email=persianasyenrrollablesgirardot@gmail.com \
    -c user.name="Jhon Cubides" \
    add -A
git -c user.email=persianasyenrrollablesgirardot@gmail.com \
    -c user.name="Jhon Cubides" \
    commit -q -m "$MSG

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin main 2>&1 | tail -3
echo "  ✓ pusheado. Vercel auto-deploya en ~30s — https://pwa-junior.vercel.app"
