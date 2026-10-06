# CLAUDE.md — mémoire du projet

Fork de `0xlocker/D17` (licence MIT), devenu un launchpad propriétaire « D17 V15 »
avec frais de protocole. Dépôt : `dr4c0-git/D17`. Branche de travail :
`claude/hopeful-pasteur-4lq2ho`. Docs amont : https://d17docs.vercel.app/docs
(inaccessible depuis le sandbox cloud ; copies locales dans `docs/`).

## Contraintes permanentes (fixées par le propriétaire)

- **Licence** : ne jamais modifier la ligne `Copyright (c) 2026 D17 contributors` de
  `LICENSE` ni les en-têtes `SPDX-License-Identifier: MIT`. On peut *ajouter* une ligne.
- **Sepolia avant mainnet** : toute modification de contrat passe par
  `npm run test:contracts`, puis un déploiement + un lancement complet sur Sepolia.
- **Jamais de clé privée dans le dépôt** : uniquement dans `contracts/.env` (ignoré).
  Les `*.example` restent vides. `check:release` refuse les affectations de clés.
- **Objectif produit** : zéro arnaque possible, tout public, mécanisme impossible à
  contourner. Garanties : aucun accès discrétionnaire du créateur aux fonds, LP
  verrouillée pour toujours, règles immuables par lancement (`rulesHash`), aucune clé
  admin sur la chaîne de création.

## État (2026-10-06)

- Étape 1 (analyse) faite. Étape 2 (frais + correction de tous les risques) faite et
  poussée : commits `f3442cb` (deployer), `fd9e635` (contrats), `4a3d92e` (outillage),
  `b8ecb7e` (apps), puis docs/release.
- **V15 n'est déployé nulle part.** Manifests `deployments/*.json` (4 copies + 
  `release/deployments/`) en `"status": "not-deployed"` avec adresses nulles. Les
  adresses V14 amont sont incompatibles (ABI/IDs différents).
- Prochaine étape côté propriétaire : déployer sur Sepolia (voir « Déploiement »).

## Commandes

```bash
npm ci                                     # Node 22.13+ ou 24+
npm test                                   # typecheck + api + contrats + tests web
npm run test:contracts                     # 2 suites E2E (~2 min) : 567 + 52 assertions
npm run build                              # Next.js (apps/web)
npm run build:abi -w @d17/contracts        # ABI + docs/contract-explorer.html
npm run release:protocol && npm run release:checksums && npm run check:release
```

Après toute modif de contrat : `npx hardhat clean && npx hardhat compile` (un seul
build-info, sinon `release:protocol` peut lire un vieux build), `build:abi`, copier
`contracts/abi/*.abi.json` vers `apps/web/public/abi/` et `apps/api/abi/`,
`release:protocol`, régénérer `contracts/SHA256SUMS.txt`
(`cd contracts && sha256sum contracts/D17*.sol contracts/interfaces/*.sol contracts/lib/*.sol > SHA256SUMS.txt`),
puis `release:checksums` **en dernier** (le manifeste couvre chaque fichier du dépôt,
y compris ce CLAUDE.md) et `check:release`. La CI vérifie `git diff --exit-code` sur
`contracts/abi`, `release/protocol-build.json`, `release/solc-input.json`.

Compilateur : solc 0.8.24, viaIR, optimizer runs=1, evm shanghai, bytecodeHash none.

### Sandbox cloud : solc bloqué
`binaries.soliditylang.org` est refusé par le proxy. Contournement (hors dépôt) : binaire
natif depuis les releases GitHub + `soljson.js` du paquet npm `solc@0.8.24`, placés dans
`~/.cache/hardhat-nodejs/compilers-v3/{linux-amd64,wasm}/` avec un `list.json` minimal
(`path`, `version`, `longVersion`, `sha256`). Hardhat exige les deux plateformes.
Pour un nœud local en arrière-plan, ne jamais faire `pkill -f "hardhat node"` dans la
même commande shell (tue le shell) ; lancer le nœud en tâche de fond séparée.

## Architecture V15 (11 contrats, `contracts/contracts/`)

| Contrat | Rôle |
|---|---|
| `D17Factory` | Registre, validation de config, snapshot du frais (`feeConfig` immutable), `isLocker`. Refuse `createLaunch` tant que `owner != 0`. Planchers mainnet (chainid 1) : départ ≥ 24 h, fenêtres ≥ 1 h. |
| `D17FeeConfig` | **Seul owner restant** (multisig). `protocolFeeBps ≤ MAX_PROTOCOL_FEE_BPS = 200`, destinataire ; ownership en 2 étapes ; renonçable. Ne touche que les lancements futurs. |
| `D17LaunchFactory` | Crée token + launch (via deployer) + vault ; refuse si token/vault factory ou deployer ont encore un owner ; mint `manual` **dans le vault**. |
| `D17LaunchDeployer` | `new D17Launch` à partir de params pré-encodés (marge EIP-170). Épinglé puis renoncé. |
| `D17TokenFactory`, `D17LiquidityVaultFactory`, `D17LockerFactory` | Inchangés hors IDs. |
| `D17Token` | Inchangé hors ID (gate de transfert avant pool). |
| `D17Launch` | Struct `LaunchParams`. Frais de protocole figé (immutables + `rulesHash`), pénalités vers le pool, plancher d'ancre sur le round final, `effectiveLpTokens`, burn des invendus + LP inutilisée, cap de la réserve LP tardive, `burnResidualTokens`, sweep ETH→WETH. |
| `D17Locker` | Pénalité → vault ; paie `protocolFeeWeth` ; champ `protocolFeeWeth` inséré dans `LockerPosition` (décoder par **nom**, pas par index). |
| `D17LiquidityVault` | Pool initial = WETH réglé + pénalités ; liquidité tardive au ratio live (reste brûlé, LP 0 → brûlé) ; vesting créateur 180 j (`releaseCreatorTokens`, appelable par tous) ; `burnFailedLaunchPenalties` ; sweep ETH→WETH. |

IDs : `*_V15_HARDENED` partout (contrats, `scripts/lib.mjs`, apps, release).
Tailles : `D17LaunchDeployer` 22 759 o (marge 1,8 Ko : toute croissance de `D17Launch`
la consomme), `D17Launch` 17 557 o, `D17LaunchFactory` 5 129 o.

## Décision sur les frais (prise par Claude, validée « le plus honnête »)

Frais **séparé et visible** (option B), pas caché dans la part treasury :
`gross = pool + treasury (≤10 %) + protocole (≤2 %)`, pool ≥ 88 %. Prélevé **uniquement
au règlement réussi** ; jamais sur refunds, pénalités, lancements échoués. Figé par
lancement dans `rulesHash` ; le créateur consent via `maxProtocolFeeBps` (le `/deploy`
envoie exactement le taux affiché). Destinataire et taux modifiables par le multisig
pour les lancements futurs seulement.

## Statut des risques de l'analyse

| # | Risque | Statut |
|---|---|---|
| 1 | Créateur reçoit fonds via treasury | Atténué : treasury ≤10 %, pénalités → pool, invendus brûlés, allocation créateur vestée 180 j. Reste : la part treasury publiée. |
| 2 | Griefing de l'ancre (refund gratuit) | Corrigé : pénalité fixe 1 % rounds 1-2 → pool (brûlée si échec). Testé. |
| 3 | Round final bradé | Corrigé : plancher au prix d'ancre, reste brûlé ; LP proportionnelle aux ventes. |
| 4 | Marge code-size | Corrigé : `D17LaunchDeployer`. |
| 5 | Pas d'audit | **Non corrigeable ici.** Slither 0.11.6 : aucun finding exploitable. Audit externe requis avant mainnet. |
| 6 | Liquidité tardive / MEV | Corrigé : ratio live, reste brûlé. Résiduel : IL d'un ajout de liquidité sandwiché. |
| 7 | Couverture de tests | Améliorée : suite `test/hardening-e2e.mjs` + helpers partagés. Pas de fuzzing. |
| 8 | Confiance au déploiement | Corrigé : launches refusés tant qu'une clé owner existe ; script de déploiement impose la renonciation ; `verify:factory` le vérifie. |
| 9 | Poussière d'arrondi | Corrigé : `burnResidualTokens()` ; + bug réel corrigé (dernier settler tardif bloqué par `LP_RESERVE_EXCEEDED`). |
| 10 | Pré-dépôt WETH dans la paire | Analysé : non exploitable, conservé (documenté). |
| 11 | Sweep bloqué par treasury | Corrigé : wrap ETH→WETH. |
| 12 | Timestamps / lancements furtifs | Planchers mainnet (24 h d'annonce, fenêtres ≥ 1 h). Non testé localement (chainid 1). |
| 13 | Front-end | Vérifie feeConfig + wiring ; bannière « non déployé » ; décodage par nom ; panneau « Creator vesting » + bouton de release dans l'étape Trading (testé en navigateur sur nœud local). |

Autres bugs corrigés : nonce du script de déploiement (`NonceManager` par clé).

## Déploiement (à faire par le propriétaire, clés hors dépôt)

1. `cp contracts/.env.example contracts/.env` ; remplir `RPC_URL` (Sepolia),
   `D17_FACTORY_PRIVATE_KEY`, `D17_LOCKER_FACTORY_PRIVATE_KEY` (clé différente),
   `FEE_CONFIG_OWNER` (Safe), `PROTOCOL_FEE_RECIPIENT`, `PROTOCOL_FEE_BPS`,
   `RENOUNCE_D17_FACTORY_OWNER=1`.
2. `npm run compile -w @d17/contracts && npm run deploy:factory -w @d17/contracts`
3. `npm run verify:factory -w @d17/contracts` (toutes les vérifs doivent passer)
4. `npm run publish:deployment -w @d17/contracts` (écrit les manifests + provenance)
5. Lancement complet de test (`create:launch` + terminal), puis régénérer
   checksums/release, commit.
6. Mainnet seulement après audit ; `D17_CONFIRM_MAINNET_DEPLOY=1` + owner fee = contrat.

Dry-run local validé : deploy → verify (40/40) → create-launch (frais 1 % figé).

Test UI local (sans toucher au dépôt) : config Hardhat temporaire avec
`networks.hardhat.chainId = 11155111` lancée via
`npx hardhat --config <tmp> --network hardhat node` (sans `--network hardhat`, le
chainId reste 31337), manifest `apps/web/deployments/sepolia.json` + `.env.local`
pointés sur le nœud, Playwright (scratchpad) avec un `window.ethereum` injecté qui
relaie vers le nœud et `page.clock` calé sur l'heure de la chaîne. Restaurer ensuite le
manifest, supprimer `.env.local` et `git checkout apps/web/next-env.d.ts` (réécrit par
`next dev`).

## Documentation (à maintenir avec le code)

- `docs/V15_HARDENING.md` : divulgation publique des changements V15 et du frais.
- `docs/CONTRACTS_TECHNICAL.md` : référence V15 avec citations `Fichier.sol:ligne` —
  **toute modif de contrat décale des lignes : revérifier les citations.**
- `contracts/docs/ABI_TRACEABILITY.md` : 364 entrées classées (consommateur, indexé ou non).
  Après un changement d'ABI, reprendre la classification V15 existante et classer à la main
  les nouvelles entrées (pas de générateur dans le dépôt).
- `docs/blog/` : 9 essais V15 (le 09 explique le frais de protocole).
- Prix d'ouverture : il suit le prix moyen payé et lui est égal (net des frais) seulement si
  `lpTokens == saleTokens` ; ne jamais écrire qu'il est toujours égal.

## Reste à faire

- Tests de fuzzing/invariants ; test des planchers mainnet (nœud avec chainId 1).
- Audit externe.
- Optionnel : ajouter une ligne de copyright du fork dans `LICENSE` (sans retirer l'existante).
