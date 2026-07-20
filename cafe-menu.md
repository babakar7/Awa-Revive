# Revive — Menu du bar (SEED initial)

<!--
  ⚠️ Ce fichier n'est plus la source de vérité vivante. Il sert UNIQUEMENT de
  seed au tout premier boot (table cafe_menu_items vide → import). Ensuite la
  vérité vit en DB et s'édite dans l'admin : awa.revive.sn → Bar → Menu bar
  (ajouter / modifier / retirer un article, sans redéploiement). Éditer ce
  fichier après le premier boot n'a AUCUN effet.

  Les recettes internes (ingrédients + étapes) ne sont pas seedées ici : elles
  se complètent uniquement dans la fiche article de /admin/menu et ne sont
  jamais transmises à Awa ni aux clients.

  Les prix facturés dans les liens Wave viennent toujours du serveur (table),
  jamais de l'IA.

  Format d'une ligne article (obligatoire, sinon la ligne est ignorée) :
    - ID | Nom affiché | prix | description

  Règles :
  - ID : MAJUSCULES/chiffres/underscore, unique, et STABLE — ne JAMAIS changer
    un ID existant (il sert de référence dans les commandes) ; changer librement
    le nom affiché, le prix ou la description.
  - prix : nombre entier en FCFA, sans espace ni point (ex : 3000).
  - description : optionnelle.
  - Tout le reste (titres ##, phrases libres) est du texte d'ambiance
    qu'Awa voit tel quel — utilisez-le pour des notes et précisions.
-->

## SMOOTHIES

Tous les smoothies sont à 3 000 FCFA.

- SMOOTHIE_JANT_BI | Jant Bi | 3000 | Soleil de Dakar en verre : papaye, ananas & orange pressée, une pointe de miel. Vitamine C.
- SMOOTHIE_COCO_BEACH | Coco Beach | 3000 | Évasion tropicale : mangue, ananas & lait de coco onctueux. Végan, sans lactose.
- SMOOTHIE_SHAKE_IT_UP | Shake It Up | 3000 | Gourmand & rassasiant : banane, chia, beurre de cacahuète & avoine. Végan.
- SMOOTHIE_POWER_START | Power Start | 3000 | Le carburant d'après-séance : banane, dattes, amandes & flocons d'avoine. Végan, protéiné.

Suppléments smoothie (500 FCFA chacun) :

- SUPP_SMOOTHIE_WHEY | Supplément protéine whey | 500 | à ajouter à un smoothie
- SUPP_SMOOTHIE_CHIA | Supplément chia | 500 | à ajouter à un smoothie
- SUPP_SMOOTHIE_MIEL | Supplément miel | 500 | à ajouter à un smoothie
- SUPP_SMOOTHIE_BEURRE_CACAHUETE | Supplément beurre de cacahuète | 500 | à ajouter à un smoothie
- SUPP_SMOOTHIE_BAOBAB | Supplément baobab | 500 | à ajouter à un smoothie

## SHOTS

- SHOT_BOOST_ENERGY | Boost-Energy | 1000 | Le coup de fouet : orange, ananas, curcuma & gingembre.

## FRAÎCHEUR

- FRAICHEUR_ZEST_UP | Zest'Up | 2500 | Thé vert glacé, orange, citron & menthe fraîche, sucre brun.
- FRAICHEUR_HIBISUN | HibiSun | 2000 | Infusion d'hibiscus glacée, citron & sucre brun. Rubis rafraîchissant. Végan.
- FRAICHEUR_SOLEA | Solea | 2000 | Crémeux glacé mangue & ananas.

## JUS DÉTOX

- DETOX_PURIF_VERT | Purif'Vert | 2500 | Le grand nettoyage : concombre & céleri ultra-frais, gingembre & citron. Végan.
- DETOX_DYNAMO_VERT | Dynamo Vert | 2500 | Vert et vivifiant : pomme, banane, épinards, citron & une touche de miel.

## BOISSONS CHAUDES

- CHAUD_THE | Thé | 1500
- CHAUD_ESPRESSO | Espresso | 1500
- CHAUD_CHOCOLAT | Chocolat chaud | 2500
- CHAUD_CAPPUCCINO | Cappuccino | 2500
- CHAUD_CAPPUCCINO_VANILLE | Cappuccino vanille | 3000
- CHAUD_CAPPUCCINO_CARAMEL | Cappuccino caramel | 3000
- CHAUD_ICED_LATTE | Iced Latte | 3000

## ICED MATCHA

Matcha de cérémonie, lait d'avoine ou lait de vache — demander la préférence
du client et la noter dans la commande (order_note).

- MATCHA_VANILLE | Iced Matcha Vanille | 3500 | Matcha & vanille, doux et crémeux.
- MATCHA_PISTACHE | Iced Matcha Pistache | 4000 | Matcha, vanille & crème de pistache. Notre chouchou.
- MATCHA_MANGUE | Iced Matcha Mangue | 4000 | Matcha, vanille & mangue, fruité et frais.
- MATCHA_MADD | Iced Matcha Madd | 4000 | Matcha & madd — la touche 100% sénégalaise. Local.
- MATCHA_CAFE | Iced Matcha Bar | 4000 | Matcha & espresso : le meilleur des deux mondes.
- SUPP_MATCHA_TAPIOCA | Supplément perles de tapioca | 500 | à ajouter à un matcha

## À MANGER — HEALTHY BITES

- BITE_CHICKEN_POKE | Chicken Poke | 6000 | Bowl frais : poulet, riz vinaigré, mangue, avocat, maïs, poivrons & concombre.
- BITE_NOUILLES_POULET | Nouilles au poulet | 6000 | Poulet teriyaki, nouilles sautées, légumes croquants & graines de sésame. Protéiné.

## SALADES

- SALADE_LIGHT | Salade Light | 3000 | Laitue, œuf, tomate, chèvre & pain grillé aux graines, vinaigrette.
- SALADE_CHICKEN_CRUNCH | Chicken Crunch | 5000 | Poulet croustillant, laitue, maïs, fromage, tomate & œuf, sauce douce à l'ail. Protéiné.

## TOASTS

- TOAST_TUNA | Tuna Toast | 4000 | Pain grillé, fromage frais & œuf brouillé, thon, salade, tomates cerises marinées.
- TOAST_SALMON | Salmon Toast | 5500 | Pain grillé, fromage frais & œuf brouillé, saumon fumé, avocat, chèvre, vinaigrette.

Suppléments toast (500 FCFA chacun) :

- SUPP_TOAST_FROMAGE | Supplément fromage (chèvre, brie ou tomme) | 500
- SUPP_TOAST_OEUFS | Supplément œufs | 500
- SUPP_TOAST_JAMBON | Supplément jambon | 500
- SUPP_TOAST_POMMES_DE_TERRE | Supplément pommes de terre sautées | 500

## BRUNCH

- BRUNCH_MYKONOS | Brunch Mykonos | 7500 | Le grand plateau : toast & fromage frais, roquette, jambon, tomates & pommes de terre sautées, avocat. Jus d'orange ou boisson chaude inclus — demander le choix du client et le noter dans la commande.
