# CLAUDE.md — mémoire du projet

Fork de `0xlocker/D17` (licence MIT), destiné à devenir un launchpad propriétaire
avec un modèle de frais de protocole. Dépôt : `dr4c0-git/D17`.
Docs amont : https://d17docs.vercel.app/docs (copie locale : `docs/`, `contracts/docs/`).

## Contraintes permanentes (fixées par le propriétaire)

- **Licence** : conserver le fichier `LICENSE` MIT d'origine et sa ligne
  `Copyright (c) 2026 D17 contributors`. On peut *ajouter* une ligne de copyright,
  jamais retirer l'existante. Garder les en-têtes `SPDX-License-Identifier: MIT`.
- **Sepolia avant mainnet** : toute modification de contrat est testée en local
  (`npm run test:contracts`) puis déployée et exercée sur Sepolia avant tout mainnet.
- **Jamais de clé privée dans le dépôt** : les clés vivent uniquement dans
  `contracts/.env` (ignoré par git). Ne remplir que les fichiers `*.example` avec
  des valeurs vides. Vérifier `git diff --cached` avant chaque commit.
- **Garanties à préserver** : aucun accès discrétionnaire du créateur aux fonds des
  participants, LP verrouillée pour toujours dans le vault, règles immuables par
  lancement (rulesHash), factories sans owner après déploiement.
- Étape 1 (analyse) terminée le 2026-10-06 — aucun code modifié. Les étapes
  suivantes (implémentation des frais) restent à valider par le propriétaire.

## Commandes

```bash
npm ci                     # Node 22.13+ ou 24+
npm test                   # typecheck + api + contracts + tests web
npm run test:contracts     # E2E Hardhat local (~1 min, 493 assertions)
npm run build              # build Next.js (apps/web)
npm run build:abi -w @d17/contracts && npm run release:protocol && npm run check:release
```

La CI (`.github/workflows/ci.yml`) exige en plus que `contracts/abi`,
`release/protocol-build.json` et `release/solc-input.json` soient régénérés et
commités (`git diff --exit-code`). Toute modif de contrat ⇒ régénérer ABI,
release, checksums (`npm run release:checksums`), `contracts/docs/contract-explorer.html`.

`RELEASE_SHA256SUMS.txt` couvre **chaque fichier du dépôt** (y compris ce
CLAUDE.md) : après tout ajout/modification de fichier, lancer
`npm run release:checksums` puis `npm run check:release`, sinon la CI casse.

Compilateur : solc 0.8.24, viaIR, optimizer runs=1, evm shanghai, bytecodeHash none.

### Sandbox cloud : solc bloqué
`binaries.soliditylang.org` est refusé par le proxy. Contournement (hors dépôt) :
binaire natif depuis GitHub releases + `soljson.js` depuis le paquet npm `solc@0.8.24`,
placés dans `~/.cache/hardhat-nodejs/compilers-v3/{linux-amd64,wasm}/` avec un
`list.json` minimal (champs `path`, `version`, `longVersion`, `sha256`).

## Résultat des tests (2026-10-06, commit 57a63ab)

Tout passe : typecheck, build web, test:api (2 smokes), test:contracts
(493/493 assertions, 18 lockers, 67 actions), test:guard, activity-dedupe,
activity-history, build:abi, check:explorer, release:protocol, check:release
(280/280 + 37 liens doc). Aucun diff après régénération ⇒ build reproductible.
Seul le harnais E2E existe (`contracts/test/local-e2e.mjs`) : pas de tests
unitaires ni de fuzzing/invariants.

## Architecture (9 contrats, `contracts/contracts/`)

| Contrat | Rôle |
|---|---|
| `D17Factory` | Registre racine. Valide la config (`_validateConfig`), appelle `D17LaunchFactory`, enregistre `launches[launch]` + `rulesHash`, registre `isLocker`. Owner seulement pour épingler (une fois) launchFactory/lockerFactory puis renoncer. Détient `weth` et `router` (immutables). |
| `D17LaunchFactory` | Déploie en une tx : token (via TokenFactory), `new D17Launch`, vault (via VaultFactory) ; configure gate de trading + métadonnées ; mint `sale+lp` au launch, `manual` au créateur, `dead` à 0x…dEaD ; ferme le mint ; renonce à l'ownership du token. **Runtime 24 469 o / 24 576 (EIP-170) : 107 octets de marge.** |
| `D17TokenFactory` | Déploie `D17Token`. Owner épingle launchFactory puis renonce. |
| `D17LiquidityVaultFactory` | Déploie `D17LiquidityVault`. Même schéma d'épinglage. |
| `D17LockerFactory` | `createLockerFor(self)` : un `D17Locker` par participant, enregistré dans `D17Factory.isLocker`. |
| `D17Token` | ERC-20 à offre plafonnée. Transferts bloqués avant ouverture sauf `launch → *` et `vault → paire`. Burn pré-ouverture réservé au launch. Métadonnées on-chain (`contractURI`). |
| `D17Launch` | Machine d'état et comptabilité : 5 rounds, fenêtres de refund, ancre de prix, rollover, finalisation, quote-part LP, règlement tardif. **Ne détient jamais de WETH**, seulement les tokens sale+LP. |
| `D17Locker` | Coffre personnel du participant : wrap ETH→WETH, garde le WETH, appelle le launch, route WETH vers vault/treasury au règlement, garde les tokens jusqu'à l'ouverture. Seul contrat qui **déplace le WETH**. |
| `D17LiquidityVault` | Crée la paire Uniswap V2 officielle, mint la LP vers lui-même (aucune fonction de retrait de la LP ⇒ verrouillage permanent), ajoute la liquidité tardive. |

Lib : `lib/D17SafeTransfer.sol`. Interfaces : `interfaces/ID17*.sol`.
Les IDs de version (`*_V14_1_REFUND_SCHEDULE_BURN_GATE`) sont vérifiés par le
Locker (`EXPECTED_LAUNCH_ID`) et les apps : tout changement de logique ⇒ nouvel ID.

## Flux d'un lancement

1. **Création** — le créateur appelle `D17Factory.createLaunch(config)`. Supply =
   sale + lp + manual (≤10 %) + dead. `treasury` et `treasuryBps` (≤20 %),
   `refundPenaltyBps` (≤50 %), durées, minimums, parts de rounds et option
   burn/treasury des invendus sont fixés et hachés dans `rulesHash`.
2. **Round 0 (ancre)** — commits via le Locker (`commitToRound`, ETH→WETH gardé
   dans le locker). Prix d'ancre = WETH levé / allocation round 0. Il faut
   `minPhase1Weth` et `minAnchorPriceWad`, sinon `launchFailed()` après la fenêtre
   de refund ⇒ remboursement intégral (`refundFailedLaunch`).
3. **Fenêtres de refund** après les rounds 0–3 : rounds 0–1 sans pénalité,
   rounds 2–3 avec `refundPenaltyBps` (pénalité → treasury). Round final : pas de refund.
4. **Rounds 1–3** — tokens vendus = min(allocation, levé/prix d'ancre) ; le
   non-vendu roule vers le round final. **Round 4** — distribue base + rollover au
   pro-rata quel que soit le montant levé.
5. **Finalisation** (`finalizeLaunch`, appelable par tous après le round 4) —
   fige `finalCommittedWeth`, brûle ou envoie au treasury les invendus.
6. **Règlement** (`settleAndClaim` propriétaire, ou `settleAfterGrace` par n'importe
   qui après la grâce) — par position : `treasuryWeth = gross·treasuryBps`,
   `wethForVault = gross − treasuryWeth` → vault ; tokens crédités au locker ;
   surplus éventuel → retirable.
7. **Pool** (`createOfficialPool`, appelable par tous à `poolCreationOpensAt`) —
   paire au ratio canonique `lpTokens : totalLiquidityWeth` pour la fraction déjà
   réglée ; le reste des LP tokens est réservé pour les retardataires.
8. **Trading ouvert** = pool créée. Retrait des tokens depuis les lockers.
9. **Règlement tardif** (`claimLateSettlement` + `mintLateLiquidity`, atomique) —
   même prix et mêmes frais, la quote-part WETH + LP tokens réservés rejoint la paire.

## Proposition : frais de protocole (non implémentée)

**Où** : le WETH ne vit que dans les Lockers ; la répartition est calculée dans
`D17Launch._vaultSettlementAmounts` et exécutée dans `D17Locker._settleVaultPosition`.
C'est le seul point d'insertion cohérent.

**Option A (recommandée) — prélèvement sur la part treasury**
- `protocolFeeWeth = gross · protocolFeeBps / BPS`, déduit de `treasuryWeth`
  (exiger `treasuryBps ≥ protocolFeeBps`). `wethForVault` inchangé ⇒
  `totalLiquidityWeth`, ratio LP, `lateLpTokens` inchangés : aucun impact sur la
  math LP ni sur les participants.
- Option B (frais additionnel, réduit la LP) : `wethForVault = gross − treasury − fee`
  et `totalLiquidityWeth` doit utiliser `BPS − treasuryBps − protocolFeeBps` ;
  borne combinée à imposer. Plus invasif.

**Configuration**
- Plafond codé en dur : `uint16 constant MAX_PROTOCOL_FEE_BPS` (ex. 300 = 3 %).
- Petit contrat `D17FeeConfig` (owner = multisig Safe, idéalement derrière un
  timelock) avec `feeRecipient` et `protocolFeeBps ≤ MAX`, modifiables **pour les
  lancements futurs uniquement**.
- À la création, `D17Factory` lit la config et la **fige** dans les immutables du
  `D17Launch` (`protocolFeeBps`, `protocolFeeRecipient`), incluses dans `rulesHash`
  ⇒ un lancement existant ne peut jamais voir ses frais changer.
- Le Locker transfère `protocolFeeWeth` en WETH (pas d'ETH natif ⇒ pas de DoS par
  destinataire qui revert) vers `ID17Launch(launch).protocolFeeRecipient()`.
- Aucun frais sur refunds, pénalités ou lancements échoués (garanties de sortie intactes).
- Nouveaux événements (`ProtocolFeePaid`), getters, mise à jour des previews
  (`previewVaultSettlement` doit renvoyer le frais).

**Impacts obligatoires**
- Taille de code : `D17LaunchFactory` est à 107 o de la limite. Extraire
  `new D17Launch(...)` dans un `D17LaunchDeployer` épinglé (même schéma que
  TokenFactory/VaultFactory) avant d'ajouter la moindre logique au Launch.
- Nouveaux IDs de version (V15…) dans tous les contrats + `EXPECTED_LAUNCH_ID` du Locker.
- Mettre à jour `ID17.sol`, apps web/API (calcul des previews, affichage du frais),
  `local-e2e.mjs` (assertions de conservation : `gross = vault + treasury + fee + résiduel`),
  ABI, release, checksums, docs, manifests `deployments/*.json` (nouvelles adresses).
- Alternative en tokens (bucket de supply pour le protocole) possible mais touche
  l'invariant de split de supply et le cap de 10 % : déconseillé en v1.

## Risques de sécurité relevés (code actuel)

Élevé / important
1. **Le créateur a un accès aux fonds via `treasury`** (adresse qu'il choisit) :
   jusqu'à 20 % de toute la levée, les pénalités de refund (≤50 % des montants
   remboursés en rounds 2–3), les tokens invendus si `burnUnsoldSaleTokens=false`,
   les excédents balayés, + jusqu'à 10 % de la supply en `manual`. C'est public et
   plafonné, mais la garantie « pas d'accès du créateur aux fonds » n'est vraie que
   pour la part LP.
2. **Griefing de l'ancre (round 0)** : refund gratuit en fenêtre 0. Une baleine
   peut gonfler le round 0 (diluant les autres), puis se rembourser à la dernière
   seconde ⇒ ancre sous `minPhase1Weth` ⇒ lancement échoué, coût = gas.
3. **Round final** : base + tout le rollover distribués au pro-rata quel que soit
   le montant levé ⇒ prix potentiellement très inférieur au prix LP (arbitrage
   immédiat à l'ouverture) ; si personne ne commit, tout le pool final est invendu
   ⇒ treasury (créateur) si non brûlé.
4. **Marge de code-size quasi nulle** sur `D17LaunchFactory` (bloquant pour toute évolution).
5. **Pas d'audit professionnel** (le README le dit) ; contrats non upgradables et
   ownership renoncée ⇒ un bug est définitif.

Moyen
6. **Liquidité tardive au ratio canonique** alors que la paire trade : `pair.mint`
   garde l'excédent comme donation ⇒ décalage de prix exploitable (MEV/sandwich),
   d'autant que `settleAfterGrace` est appelable par n'importe qui au moment choisi.
7. Couverture de tests : un seul scénario E2E ; pas de fuzzing/invariants
   (conservation WETH, somme des LP tokens ≤ lpTokens, etc.).
8. Confiance au déploiement : l'épinglage des factories et la renonciation dépendent
   du script (`RENOUNCE_D17_FACTORY_OWNER=1`). Vérifier on-chain avec
   `verify:factory` que `owner == 0` sur D17Factory, TokenFactory, VaultFactory.

Faible
9. Poussière d'arrondi : LP tokens réservés jamais libérés en totalité (restent dans le launch).
10. Pré-dépôt de WETH dans la paire accepté (donation de l'attaquant, prix d'ouverture plus haut).
11. `sweepUnexpectedEthToTreasury` échoue si le treasury refuse l'ETH (sans impact sur les fonds).
12. Dépendance à `block.timestamp` (rounds ≥ 60 s ; dérive de quelques secondes).
13. Front-end : les utilisateurs signent ce que l'app leur présente ; épingler les
    adresses des manifests et vérifier `rulesHash` côté client.

Points positifs : reentrancy guards partout, CEI respecté, WETH (pas d'ETH natif)
pour les flux de fonds, vérification `rulesHash` + `isCanonicalLaunch` à chaque
commit, gate de transfert du token empêchant le pré-seed de la paire, LP sans
fonction de retrait, `.env*` ignorés par git.

## Prochaines étapes suggérées

1. Valider le choix A/B et les paramètres (plafond, destinataire = Safe).
2. Extraire `D17LaunchDeployer` (sans changement de logique), re-tester.
3. Implémenter le frais + tests E2E/invariants, régénérer ABI/release.
4. Corriger/atténuer les risques 2, 3, 6 si souhaité (changent les règles ⇒ nouvel ID).
5. Déploiement Sepolia avec clés dédiées hors dépôt, `verify:factory`, lancement test complet.
6. Audit externe avant mainnet.
