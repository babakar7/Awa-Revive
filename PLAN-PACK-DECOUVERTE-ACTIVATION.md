# Activation automatique des plans — décision produit actuelle

## Décision

L’e-mail Wix de bienvenue/définition de mot de passe est désormais un compromis
produit accepté, à condition d’être annoncé avant paiement. Awa provisionne donc
un membre Wix pour toute vente de plan lorsque le client n’en possède pas déjà.
Le mot de passe reste facultatif : il n’est nécessaire ni pour l’activation du
plan, ni pour réserver avec Awa.

L’ancien no-go sur `createMember` est clos et ne doit plus guider le code.

## Parcours

1. Le client choisit un plan et donne son nom.
2. Awa appelle `create_plan_payment_link` sans inventer d’identité.
3. Si aucun membre Wix n’existe, le serveur exige une preuve par e-mail :
   `request_email_verification` reçoit le nom déjà connu dès le premier appel,
   envoie un code, puis `submit_verification_code` prouve ou crée la fiche.
4. Un code encore valide est réutilisé ; aucun second e-mail n’est envoyé. Un
   code expiré peut être renvoyé.
5. Après toutes les gardes de catalogue, d’éligibilité, de renouvellement et de
   moyen de paiement, le serveur crée le membre Wix juste avant le draft.
6. Le webhook de paiement crée l’ordre offline et confirme « ACTIF ».

La fiche prouvée par e-mail prime sur l’index téléphone :
`verified.linked_contact_id ?? contactId`. Cette identité unique sert à
l’éligibilité Pack Découverte/L’Invitée, à la continuité des Clés et à
`latestPlanEndDate`.

## Garde-fous

- Aucun paiement si le membre créé est rattaché à une autre fiche.
- Aucun paiement si Wix refuse la création ou signale un conflit d’e-mail qui
  ne se résout pas vers le membre attendu.
- La réception est notifiée une seule fois dans ces cas.
- `createMember` n’est jamais appelé avant les gardes métier et le choix du rail
  de paiement.
- `PACK_DISCOVERY_CONTINUATION_PLAN_IDS` reste réservé à la réception.
- La campagne Meta conserve ses codes `discovery_member_*`.
- Le webhook reste idempotent : une double livraison, même sous deux event IDs,
  ne peut pas activer deux fois le plan.

## Fallback manuel

Si le client refuse la vérification ou ne peut pas accéder à sa boîte, Awa
explique que l’activation ne sera pas instantanée et rappelle
`create_plan_payment_link` avec `client_declined_verification:true`. Le paiement
peut alors être créé avec `member_id = null`; le webhook notifie la réception
une seule fois pour une activation manuelle.

Un incident technique ou une incohérence Wix n’utilise pas ce fallback : aucun
paiement n’est pris tant que l’identité n’est pas sûre.

## API Wix vérifiée

- Un `contactId` nu comme `memberId` reste invalide (`MEMBER_DOESNT_EXIST`).
- `POST /members/v1/members` crée le membre et peut envoyer l’e-mail Wix.
- `POST /pricing-plans/v2/checkout/orders/offline` exige le vrai `memberId`.
- L’attribution manuelle depuis le dashboard reste disponible en secours.

Scripts de sonde : `npm run wix:probe-member` et
`npm run wix:probe-contact-plan`.

## Validation attendue

- Décision pure : membre existant, code actif/expiré, fiche prouvée prioritaire.
- Provisioning : succès, mismatch, conflit d’e-mail, panne Wix, reprise après
  écriture Wix incertaine et notification unique.
- Outil : vérification requise, création différée, auto après paiement et
  fallback manuel explicite.
- Webhook : activation unique avec `member_id`, notification manuelle unique
  sans `member_id`, panne offline sans perte du paiement.
