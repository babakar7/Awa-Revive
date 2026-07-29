import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatOwnerAlert,
  isKnownInformationalSubject,
  ownerAlertVerdict,
  shouldAlertOwner,
} from "../src/domain/ownerAlertRules.js";

describe("ownerAlertVerdict", () => {
  it("wakes the owner for every alert that asks a human to act", () => {
    const interventions = [
      "⚠️ Crash technique (uncaughtException)",
      "⚠️ Échec technique — un client est planté",
      "⚠️ Awa mise en pause — erreur répétée",
      "💸 REMBOURSEMENT à faire — 15000 FCFA",
      "💸 REMBOURSEMENT à vérifier — paiement livraison tardif/double",
      "🙋🏾 Handoff client — la cliente veut parler à quelqu'un",
      "🔴 Conversation à reprendre — cas grave",
      "🛡️ Demande de garantie L'Invitée",
      "🔀 Compte vérifié par email — fusion de doublons requise",
      "🔗 Liaison de compte en attente — 1 clic dans le dashboard",
      "🎫 ABONNEMENT payé — activation manuelle : L'Habituée",
      "⏰ Commande livraison en retard (+25 min)",
      "Nouveau client WhatsApp à relier (doublon de contact)",
    ];

    for (const subject of interventions) {
      expect(shouldAlertOwner(subject), subject).toBe(true);
    }
  });

  it("stays silent on the purely informational traffic", () => {
    const informational = [
      "🛵 Nouvelle commande livraison",
      "🗓️ Nouvelle livraison programmée",
      "✅ Livraison payée — départ autorisé",
      "💵 Espèces choisies — livraison",
      "📋 Récap du jour — conversations & suivis",
      "Nouveau message pendant un relais humain",
    ];

    for (const subject of informational) {
      expect(shouldAlertOwner(subject), subject).toBe(false);
    }
  });

  it("never wakes the owner for a test order, even when it looks like an incident", () => {
    const verdict = ownerAlertVerdict("🧪 TEST — ⚠️ Cuisine NON notifiée — commande livraison");

    expect(verdict).toEqual({ alert: false, reason: "test" });
  });

  it("lets a caller force or suppress the copy whatever the wording", () => {
    expect(ownerAlertVerdict("Sujet totalement inédit", true)).toEqual({
      alert: true,
      reason: "forced",
    });
    expect(ownerAlertVerdict("⚠️ Anomalie", false)).toEqual({ alert: false, reason: "opted_out" });
  });

  it("classifies on the subject only — an alarming body never triggers on its own", () => {
    // « en attente » vit dans le corps de chaque nouvelle commande livraison.
    expect(shouldAlertOwner("🛵 Nouvelle commande livraison")).toBe(false);
    expect(shouldAlertOwner("🔗 Liaison de compte en attente")).toBe(true);
  });

  it("reports an unknown subject as unclassified rather than guessing", () => {
    expect(ownerAlertVerdict("Bulletin météo")).toEqual({ alert: false, reason: "unclassified" });
  });
});

describe("formatOwnerAlert", () => {
  it("marks the subject as an intervention and keeps the reception body intact", () => {
    const body = "Client : Fatou\nOuvrir : https://awa.revive.sn/admin/conversations/42";
    const alert = formatOwnerAlert("💸 REMBOURSEMENT à faire — 15000 FCFA", body);

    expect(alert.subject).toBe("🚨 INTERVENTION — 💸 REMBOURSEMENT à faire — 15000 FCFA");
    expect(alert.body).toBe(body);
  });
});

/**
 * Filet anti-oubli : chaque sujet réellement passé à notifyReception() doit
 * être classé — intervention (le gérant est réveillé) ou informatif explicite.
 * Un sujet « unclassified » fait échouer ce test : le prochain appel devra
 * choisir son camp au lieu de disparaître silencieusement du radar.
 */
describe("couverture des sujets notifyReception du dépôt", () => {
  it("classifies every subject literal passed to notifyReception", () => {
    const subjects = collectNotifyReceptionSubjects(path.resolve(__dirname, "../src"));

    expect(subjects.length).toBeGreaterThan(20); // le scanner voit bien le code
    const unclassified = subjects.filter(
      (subject) => !shouldAlertOwner(subject) && !isKnownInformationalSubject(subject),
    );

    expect(
      unclassified,
      `Sujets non classés — donne-leur un marqueur d'intervention (⚠️/💸/🔴/🙋/🛡/🔀/🔗), ` +
        `ou range-les dans INFORMATIONAL_SUBJECT_PATTERNS, ou passe ownerAlert explicitement :\n` +
        unclassified.map((s) => `  - ${s}`).join("\n"),
    ).toEqual([]);
  });
});

/** Fichiers .ts sous `dir`, récursivement. */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && full.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Extrait les littéraux de chaîne du PREMIER argument de chaque appel à
 * notifyReception(. On lit le texte de l'argument (arrêt à la virgule de
 * profondeur 1) puis on en tire tous les littéraux : un sujet ternaire
 * (« TEST » / « programmée » / normal) rend donc ses trois branches, chacune
 * devant être classée. Les `${…}` sont retirés — ils ne portent jamais la
 * partie décisive du sujet.
 */
export function collectNotifyReceptionSubjects(root: string): string[] {
  const subjects = new Set<string>();
  for (const file of sourceFiles(root)) {
    const src = fs.readFileSync(file, "utf8");
    for (const argument of firstArguments(src, "notifyReception(")) {
      for (const literal of stringLiterals(argument)) {
        const cleaned = literal.replace(/\$\{[^}]*\}/g, "").trim();
        if (cleaned) subjects.add(cleaned);
      }
    }
  }
  return [...subjects];
}

/** Texte source du premier argument de chaque appel `name(`. */
function firstArguments(src: string, name: string): string[] {
  const out: string[] = [];
  let from = src.indexOf(name);
  while (from !== -1) {
    let depth = 1;
    let quote: string | null = null;
    let i = from + name.length;
    const start = i;
    for (; i < src.length && depth > 0; i += 1) {
      const char = src[i];
      if (quote) {
        if (char === "\\") i += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "(" || char === "[" || char === "{") depth += 1;
      else if (char === ")" || char === "]" || char === "}") depth -= 1;
      else if (char === "," && depth === 1) break;
    }
    out.push(src.slice(start, i));
    from = src.indexOf(name, from + name.length);
  }
  return out;
}

/** Littéraux "…", '…' et `…` contenus dans un fragment de code. */
function stringLiterals(code: string): string[] {
  return [...code.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`]*)`/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}
