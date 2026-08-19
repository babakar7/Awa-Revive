#!/usr/bin/env sh
# Railway build step (wired via railway.json "buildCommand").
#
# VERROU « git uniquement » : Railway ne fournit RAILWAY_GIT_COMMIT_SHA que pour
# un déploiement déclenché par GitHub (push sur main → CI → deploy). Un
# `railway up` (upload d'un dossier local, sans git ni CI) n'en a PAS → le build
# échoue ici et la prod reste sur le dernier déploiement git. Incident du
# 18/08/2026 : un `railway up` lancé depuis le hub périmé a remplacé la prod
# par un arbre du 16/08 toute une nuit (moteur d'annulation auto disparu).
#
# Porte de secours (hotfix « prod à terre » uniquement, cf. CLAUDE.md §Git) :
# poser temporairement la variable de service ALLOW_LOCAL_UPLOAD=1 dans
# Railway (`railway variables --set ALLOW_LOCAL_UPLOAD=1`), déployer, puis la
# retirer aussitôt.
set -eu

if [ -z "${RAILWAY_GIT_COMMIT_SHA:-}" ] && [ "${ALLOW_LOCAL_UPLOAD:-}" != "1" ]; then
  echo "" >&2
  echo "✗ REFUS : déploiement HORS GIT (railway up ?) — aucun RAILWAY_GIT_COMMIT_SHA." >&2
  echo "  La prod doit toujours == origin/main. Commite, puis \`git push origin HEAD:main\`" >&2
  echo "  (ou \`npm run agent:ship\` depuis ton worktree) et laisse l'auto-deploy faire." >&2
  echo "  Hotfix prod à terre uniquement : ALLOW_LOCAL_UPLOAD=1 (variable Railway, temporaire)." >&2
  echo "" >&2
  exit 1
fi

echo "→ build git-only OK (commit ${RAILWAY_GIT_COMMIT_SHA:-local-upload-autorisé})"
exec npm run build
