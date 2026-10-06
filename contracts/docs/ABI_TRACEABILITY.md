# D17 ABI Traceability Matrix (V15)

Purpose: enumerate every public ABI surface of the V15 contract set and assign its
intended consumer. Rows follow `contracts/abi/*.abi.json` (the same order as
`docs/contract-explorer.html`). "Mainnet Indexed" says whether the bundled API ingests
the event (`event_only` = the function itself is not indexed, only the events it emits).

- Contracts: 11
- ABI entries: 364
- Unclassified entries: 0
- Removed since V14: `D17Launch.burnUnsoldSaleTokens()` (unsold tokens are always burned),
  `D17Launch.previewSettlement(address)` (alias of `previewVaultSettlement`),
  `D17Launch.UnsoldSaleTokensPaid` event.

## Consumer Counts

- api_frontend_readonly_verification: 230
- indexer_api_activity: 47
- deployment: 11
- deployment_admin_once: 9
- launch_factory_only: 9
- frontend_participant_wallet: 7
- deployment_verification: 6
- erc20_standard_wallet_dex: 6
- locker_only: 6
- permissionless_lifecycle: 6
- safety_revert_surface: 6
- tests_and_error_mapping: 5
- fee_admin: 4
- public_recovery: 4
- owner_recovery: 2
- vault_only: 2
- d17_factory_only: 1
- deployment_admin_recovery: 1
- frontend_deploy_wallet: 1
- locker_factory_only: 1

## Matrix

| Contract | Type | Name | Mutability | Consumer | Mainnet Indexed | Keep Reason |
|---|---|---|---|---|---|---|
| D17Factory | constructor | `constructor(address,address,address,address)` | nonpayable | deployment | no | Constructor used by deploy scripts only. |
| D17Factory | event | `LaunchCreated(address,address,address,address,bytes32)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Factory | event | `LaunchFactoryPinned(address)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Factory | event | `LaunchMetadataPublished(address,bytes32,string,string,string[],string[])` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Factory | event | `LockerFactoryPinned(address)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Factory | event | `LockerRegistered(address,address,address)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Factory | event | `ManualDistributionConfigured(address,address,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Factory | event | `OwnershipTransferred(address,address)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Factory | function | `BPS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `D17_FACTORY_ID()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `LOGO_SVG_BASE64_PREFIX()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MAINNET_MIN_START_DELAY()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MAINNET_MIN_WINDOW_SECONDS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MAX_DESCRIPTION_BYTES()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MAX_LINKS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MAX_LINK_TYPE_BYTES()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MAX_LINK_URL_BYTES()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MAX_LOGO_SVG_URI_BYTES()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MAX_MANUAL_DISTRIBUTION_BPS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MAX_REFUND_PENALTY_BPS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MAX_REFUND_SECONDS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MAX_ROUND_SECONDS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MAX_SETTLEMENT_SECONDS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MAX_START_DELAY()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MAX_TREASURY_BPS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MIN_ANCHOR_PRICE_WAD()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MIN_COMMIT_WETH()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MIN_LP_TOKENS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MIN_REFUND_PENALTY_BPS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MIN_ROUND_ALLOCATION_TOKENS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `MIN_ROUND_SECONDS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `ROUND_COUNT()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `createLaunch(tuple)` | nonpayable | frontend_deploy_wallet | event_only | Public launch creation entrypoint signed by deployer wallet. |
| D17Factory | function | `feeConfig()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `isCanonicalLaunch(address,bytes32)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `isLocker(address)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `launchFactory()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `launchFactoryPinned()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `launches(address)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `lockerFactory()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `lockerFactoryPinned()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `lockersOfOwner(address)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `owner()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `pinLaunchFactory(address)` | nonpayable | deployment_admin_once | event_only | One-shot factory pin during suite deployment. |
| D17Factory | function | `pinLockerFactory(address)` | nonpayable | deployment_admin_once | event_only | One-shot locker factory pin during suite deployment. |
| D17Factory | function | `registerLockerFor(address,address)` | nonpayable | locker_factory_only | event_only | Canonical locker registration called only by D17LockerFactory. |
| D17Factory | function | `renounceOwnership()` | nonpayable | deployment_admin_once | event_only | Required before any launch can be created (enforced on-chain by D17Factory/D17LaunchFactory). |
| D17Factory | function | `router()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Factory | function | `transferOwnership(address)` | nonpayable | deployment_admin_recovery | event_only | Pre-renounce ownership management; launches are refused until the owner is renounced. |
| D17Factory | function | `weth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17FeeConfig | constructor | `constructor(address,address,uint16)` | nonpayable | deployment | no | Constructor used by deploy scripts only. |
| D17FeeConfig | event | `OwnershipTransferStarted(address,address)` | - | deployment_verification | no | Suite-level event; contract not watched by the bundled API, read by deployment verification and explorers. |
| D17FeeConfig | event | `OwnershipTransferred(address,address)` | - | deployment_verification | no | Suite-level event; contract not watched by the bundled API, read by deployment verification and explorers. |
| D17FeeConfig | event | `ProtocolFeeUpdated(address,uint16)` | - | deployment_verification | no | Public record of every protocol fee change (applies to future launches only); not watched by the bundled API. |
| D17FeeConfig | function | `D17_FEE_CONFIG_ID()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17FeeConfig | function | `MAX_PROTOCOL_FEE_BPS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17FeeConfig | function | `acceptOwnership()` | nonpayable | fee_admin | event_only | Pending owner completes the two-step handover. |
| D17FeeConfig | function | `currentFee()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17FeeConfig | function | `feeRecipient()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17FeeConfig | function | `owner()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17FeeConfig | function | `pendingOwner()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17FeeConfig | function | `protocolFeeBps()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17FeeConfig | function | `renounceOwnership()` | nonpayable | fee_admin | event_only | Optional: freezes the protocol fee forever. |
| D17FeeConfig | function | `setProtocolFee(address,uint16)` | nonpayable | fee_admin | event_only | Fee multisig sets rate (≤ 2%) and recipient for future launches only. |
| D17FeeConfig | function | `transferOwnership(address)` | nonpayable | fee_admin | event_only | Starts the two-step handover of fee control to a new multisig. |
| D17TokenFactory | constructor | `constructor(address)` | nonpayable | deployment | no | Constructor used by deploy scripts only. |
| D17TokenFactory | event | `LaunchFactoryPinned(address)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17TokenFactory | event | `OwnershipTransferred(address,address)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17TokenFactory | event | `TokenCreated(address,string,string,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17TokenFactory | function | `D17_TOKEN_FACTORY_ID()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17TokenFactory | function | `deployToken(address,string,string,uint256)` | nonpayable | launch_factory_only | event_only | Only D17LaunchFactory creates launch tokens. |
| D17TokenFactory | function | `launchFactory()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17TokenFactory | function | `launchFactoryPinned()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17TokenFactory | function | `owner()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17TokenFactory | function | `pinLaunchFactory(address)` | nonpayable | deployment_admin_once | event_only | One-shot launch factory pin during suite deployment. |
| D17TokenFactory | function | `renounceOwnership()` | nonpayable | deployment_admin_once | event_only | Required before any launch can be created (enforced on-chain by D17Factory/D17LaunchFactory). |
| D17LiquidityVaultFactory | constructor | `constructor(address)` | nonpayable | deployment | no | Constructor used by deploy scripts only. |
| D17LiquidityVaultFactory | event | `LaunchFactoryPinned(address)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17LiquidityVaultFactory | event | `LiquidityVaultCreated(address,address,address)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17LiquidityVaultFactory | event | `OwnershipTransferred(address,address)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17LiquidityVaultFactory | function | `D17_LIQUIDITY_VAULT_FACTORY_ID()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVaultFactory | function | `deployVault(address,address,address,address,address)` | nonpayable | launch_factory_only | event_only | Only D17LaunchFactory creates launch vaults. |
| D17LiquidityVaultFactory | function | `launchFactory()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVaultFactory | function | `launchFactoryPinned()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVaultFactory | function | `owner()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVaultFactory | function | `pinLaunchFactory(address)` | nonpayable | deployment_admin_once | event_only | One-shot launch factory pin during suite deployment. |
| D17LiquidityVaultFactory | function | `renounceOwnership()` | nonpayable | deployment_admin_once | event_only | Required before any launch can be created (enforced on-chain by D17Factory/D17LaunchFactory). |
| D17LaunchDeployer | constructor | `constructor(address)` | nonpayable | deployment | no | Constructor used by deploy scripts only. |
| D17LaunchDeployer | event | `LaunchDeployed(address)` | - | deployment_verification | no | Suite-level event; contract not watched by the bundled API, read by deployment verification and explorers. |
| D17LaunchDeployer | event | `LaunchFactoryPinned(address)` | - | deployment_verification | no | Suite-level event; contract not watched by the bundled API, read by deployment verification and explorers. |
| D17LaunchDeployer | event | `OwnershipTransferred(address,address)` | - | deployment_verification | no | Suite-level event; contract not watched by the bundled API, read by deployment verification and explorers. |
| D17LaunchDeployer | function | `D17_LAUNCH_DEPLOYER_ID()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LaunchDeployer | function | `deployLaunch(bytes)` | nonpayable | launch_factory_only | event_only | Only D17LaunchFactory deploys launch contracts (split out for code size). |
| D17LaunchDeployer | function | `launchFactory()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LaunchDeployer | function | `launchFactoryPinned()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LaunchDeployer | function | `owner()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LaunchDeployer | function | `pinLaunchFactory(address)` | nonpayable | deployment_admin_once | event_only | One-shot launch factory pin during suite deployment. |
| D17LaunchDeployer | function | `renounceOwnership()` | nonpayable | deployment_admin_once | event_only | Required before any launch can be created (enforced on-chain by D17Factory/D17LaunchFactory). |
| D17LaunchFactory | constructor | `constructor(address,address,address,address)` | nonpayable | deployment | no | Constructor used by deploy scripts only. |
| D17LaunchFactory | function | `CANONICAL_DEAD_RECIPIENT()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LaunchFactory | function | `d17Factory()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LaunchFactory | function | `deployLaunch(tuple,address,address,uint16)` | nonpayable | d17_factory_only | event_only | Only D17Factory may deploy a launch trio. |
| D17LaunchFactory | function | `launchDeployer()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LaunchFactory | function | `liquidityVaultFactory()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LaunchFactory | function | `tokenFactory()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LockerFactory | constructor | `constructor(address)` | nonpayable | deployment | no | Constructor used by deploy scripts only. |
| D17LockerFactory | event | `LockerCreated(address,address)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17LockerFactory | function | `createLockerFor(address)` | nonpayable | frontend_participant_wallet | event_only | Participant creates canonical personal locker. |
| D17LockerFactory | function | `d17Factory()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | constructor | `constructor(tuple)` | nonpayable | deployment | no | Constructor used by deploy scripts only. |
| D17Launch | error | `BurnFailed()` | - | tests_and_error_mapping | no | Custom revert surface for tests, API/user error handling, and review. |
| D17Launch | error | `TransferFailed()` | - | tests_and_error_mapping | no | Custom revert surface for tests, API/user error handling, and review. |
| D17Launch | event | `Finalized(uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Launch | event | `LateVaultSettlementClaimed(address,uint256,uint256,uint256,uint256,uint256,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Launch | event | `LaunchFailedRefunded(address,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Launch | event | `LiquidityPoolCreated(address,address,uint256,uint256,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Launch | event | `LiquidityVaultConfigured(address)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Launch | event | `ResidualTokensBurned(uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Launch | event | `RoundCommitted(address,uint8,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Launch | event | `RoundRefunded(address,uint8,uint256,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Launch | event | `UnexpectedEthSwept(address,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Launch | event | `UnsoldSaleTokensBurned(uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Launch | event | `UnusedLpTokensBurned(uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Launch | event | `VaultLiquidityTokensClaimed(address,uint256,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Launch | event | `VaultSettlementClaimed(address,uint256,uint256,uint256,uint256,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Launch | fallback | `fallback` | payable | safety_revert_surface | no | Rejects unsupported ETH/calls or exists as Solidity ABI surface. |
| D17Launch | function | `BPS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `CANONICAL_DEAD_RECIPIENT()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `D17_LAUNCH_ID()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `EARLY_REFUND_PENALTY_BPS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `EARLY_REFUND_ROUNDS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `FINAL_ROUND()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `MIN_ANCHOR_PRICE_WAD()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `MIN_COMMIT_WETH()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `MIN_LP_TOKENS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `MIN_ROUND_ALLOCATION_TOKENS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `NO_ROUND()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `PHASE_FAILED()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `PHASE_NOT_STARTED()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `PHASE_POOL_READY()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `PHASE_READY_TO_FINALIZE()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `PHASE_REFUND_OPEN()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `PHASE_ROUND_OPEN()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `PHASE_SETTLEMENT_OPEN()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `PHASE_TRADING_OPEN()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `REFUND_STAGE_COUNT()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `ROUND_COUNT()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `activeRefundWindow()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `activeRound()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `allFinalCommitmentsSettled()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `anchorPriceWad()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `anchorReady()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `burnResidualTokens()` | nonpayable | permissionless_lifecycle | event_only | Anyone burns per-position rounding dust once every commitment has settled. |
| D17Launch | function | `claimLateSettlement()` | nonpayable | locker_only | event_only | Post-pool late top-up settlement path. |
| D17Launch | function | `claimVaultLiquidityTokens()` | nonpayable | vault_only | event_only | Vault claims initial proportional LP token share. |
| D17Launch | function | `claimVaultSettlement()` | nonpayable | locker_only | event_only | On-time settlement path. |
| D17Launch | function | `configureLiquidityVault(address)` | nonpayable | launch_factory_only | event_only | One-shot per-launch vault binding. |
| D17Launch | function | `contributedBy(address,uint8)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `deadRecipient()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `deadTokens()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `effectiveLpTokens()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `factory()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `finalCommittedWeth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `finalRoundTokenPool()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `finalizeLaunch()` | nonpayable | permissionless_lifecycle | event_only | Permissionless launch finalization. |
| D17Launch | function | `finalized()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `finalizedAt()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `isRoundClaimable(uint8)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `lateLpTokensReleased()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `lateSettledCommittedWeth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `lateSettledLiquidityWeth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `launchFailed()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `launchPhase()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `liquidityBps()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `liquidityPoolCreated()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `liquidityVault()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `lockerPositionState(address)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `lpTokens()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `manualDistributionRecipient()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `manualDistributionTokens()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `markLiquidityPoolCreated(address,uint256,uint256,uint256)` | nonpayable | vault_only | event_only | Vault records official pool creation. |
| D17Launch | function | `metadataHash()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `minAnchorPriceWad()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `minCommitWeth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `minPhase1Weth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `officialLpMinted()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `officialPair()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `officialTokenUsedForLp()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `officialWethUsedForLp()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `penaltyWethPaid()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `poolCreatedAt()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `poolCreationOpensAt()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `poolSettledCommittedWeth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `poolSettledLiquidityWeth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `poolTokenAllocation()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `previewFinalSaleTokens(address)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `previewRoundTokens(address,uint8)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `previewVaultSettlement(address)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `protocolFeeBps()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `protocolFeeRecipient()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `protocolFeeWethPaid()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `recordRoundCommitment(uint8,uint256)` | nonpayable | locker_only | event_only | Locker records a participant round commitment. |
| D17Launch | function | `refundPenaltyBps()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `refundSeconds()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `releaseFailedRefund()` | nonpayable | locker_only | event_only | Locker-triggered failed-launch refund path. |
| D17Launch | function | `releaseRoundRefund()` | nonpayable | locker_only | event_only | Locker releases the current refundable round. |
| D17Launch | function | `retainedPenaltyWeth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `rolloverToFinalRound()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `roundAnchorTargetWeth(uint8)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `roundAnchorUnderfillRemainingWeth(uint8)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `roundBaseTokenAllocation(uint8)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `roundClaimTime(uint8)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `roundDiscoveredPriceWad(uint8)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `roundEnd(uint8)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `roundRaised(uint256)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `roundSeconds(uint256)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `roundSharesBps(uint256)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `roundSoldTokens(uint8)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `roundStart(uint8)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `roundTokenAllocation(uint8)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `rulesHash()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `saleTokens()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `settledCommittedWeth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `settledLiquidityWeth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `settlementSeconds()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `settlementStartsAt()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `startTime()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `sweepUnexpectedEthToTreasury()` | nonpayable | public_recovery | event_only | Recovery for unexpected native ETH only. |
| D17Launch | function | `token()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `totalCommittedWeth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `totalLiquidityWeth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `tradingOpen()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `tradingOpenAt()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `treasury()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `treasuryBps()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `treasuryWethPaid()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `unsoldSaleTokensBurned()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `unsoldSaleTokensSettled()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `unusedLpTokensBurned()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `vaultConfigurator()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `vaultLiquidityClaimed()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `vaultLiquidityTokensClaimed()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | function | `weth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Launch | receive | `receive` | payable | safety_revert_surface | no | Rejects unsupported ETH/calls or exists as Solidity ABI surface. |
| D17Locker | constructor | `constructor(address,address,address)` | nonpayable | deployment | no | Constructor used by deploy scripts only. |
| D17Locker | error | `TransferFailed()` | - | tests_and_error_mapping | no | Custom revert surface for tests, API/user error handling, and review. |
| D17Locker | event | `ClaimedTokensWithdrawn(address,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Locker | event | `ExcessWethRecovered(address,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Locker | event | `FailedLaunchRefunded(address,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Locker | event | `NativeEthRecovered(address,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Locker | event | `RoundCommitted(address,uint8,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Locker | event | `RoundRefunded(address,uint8,uint256,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Locker | event | `VaultSettlementCompleted(address,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Locker | event | `WethWithdrawn(address,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Locker | fallback | `fallback` | payable | safety_revert_surface | no | Rejects unsupported ETH/calls or exists as Solidity ABI surface. |
| D17Locker | function | `EXPECTED_LAUNCH_ID()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Locker | function | `ROUND_COUNT()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Locker | function | `accountedWeth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Locker | function | `commitToRound(address,uint8,bytes32)` | payable | frontend_participant_wallet | event_only | Owner commits ETH/WETH through their locker. |
| D17Locker | function | `factory()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Locker | function | `lockedWeth(address)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Locker | function | `owner()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Locker | function | `positions(address)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Locker | function | `recoverExcessWeth(address,uint256)` | nonpayable | owner_recovery | event_only | Locker-owner recovery for WETH above accounted balances. |
| D17Locker | function | `recoverNativeEth(address,uint256)` | nonpayable | owner_recovery | event_only | Locker-owner recovery for unexpected native ETH. |
| D17Locker | function | `refundCurrentRound(address)` | nonpayable | frontend_participant_wallet | event_only | Owner requests refundable round exit. |
| D17Locker | function | `refundFailedLaunch(address,bytes32)` | nonpayable | frontend_participant_wallet | event_only | Owner claims failed-launch refund. |
| D17Locker | function | `roundPosition(address,uint8)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Locker | function | `settleAfterGrace(address)` | nonpayable | permissionless_lifecycle | event_only | Anyone can settle a locker after grace. |
| D17Locker | function | `settleAndClaim(address,bytes32)` | nonpayable | frontend_participant_wallet | event_only | Owner settles and claims sale tokens. |
| D17Locker | function | `verifyLaunch(address,bytes32)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Locker | function | `weth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Locker | function | `withdrawUnlockedTokens(address,uint256)` | nonpayable | frontend_participant_wallet | event_only | Owner withdraws unlocked sale tokens. |
| D17Locker | function | `withdrawUnlockedWeth(address,uint256)` | nonpayable | frontend_participant_wallet | event_only | Owner withdraws residual/refunded WETH. |
| D17Locker | function | `withdrawableWeth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Locker | receive | `receive` | payable | safety_revert_surface | no | Rejects unsupported ETH/calls or exists as Solidity ABI surface. |
| D17LiquidityVault | constructor | `constructor(address,address,address,address,address)` | nonpayable | deployment | no | Constructor used by deploy scripts only. |
| D17LiquidityVault | error | `BurnFailed()` | - | tests_and_error_mapping | no | Custom revert surface for tests, API/user error handling, and review. |
| D17LiquidityVault | error | `TransferFailed()` | - | tests_and_error_mapping | no | Custom revert surface for tests, API/user error handling, and review. |
| D17LiquidityVault | event | `CreatorTokensReleased(address,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17LiquidityVault | event | `ExcessWethSwept(address,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17LiquidityVault | event | `FailedLaunchPenaltiesBurned(uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17LiquidityVault | event | `LateLiquidityAdded(address,address,uint256,uint256,uint256,uint256,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17LiquidityVault | event | `OfficialPoolCreated(address,uint256,uint256,uint256,uint256,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17LiquidityVault | event | `UnexpectedEthSwept(address,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17LiquidityVault | event | `UnsupportedTokenRecovered(address,address,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17LiquidityVault | fallback | `fallback` | payable | safety_revert_surface | no | Rejects unsupported ETH/calls or exists as Solidity ABI surface. |
| D17LiquidityVault | function | `BURN_ADDRESS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `CREATOR_VESTING_SECONDS()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `D17_LIQUIDITY_VAULT_ID()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `burnFailedLaunchPenalties()` | nonpayable | permissionless_lifecycle | event_only | Anyone burns the phase-one refund penalties of a failed launch. |
| D17LiquidityVault | function | `createOfficialPool(uint256,uint256)` | nonpayable | permissionless_lifecycle | event_only | Permissionless official pool creation. |
| D17LiquidityVault | function | `creatorTokensReleased()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `failedLaunchPenaltyWethBurned()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `lateLpMinted()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `lateTokenUsedForLp()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `lateTokensBurned()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `lateWethBurned()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `lateWethUsedForLp()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `launch()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `lockedCreatorTokens()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `lpMinted()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `mintLateLiquidity(uint256,uint256)` | nonpayable | locker_only | event_only | Registered locker performs atomic late liquidity top-up. |
| D17LiquidityVault | function | `officialPair()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `poolCreated()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `poolCreatedAt()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `preseededTokenReserve()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `preseededWethReserve()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `recoverUnsupportedTokenToTreasury(address,uint256)` | nonpayable | public_recovery | event_only | Recovery for unsupported token donations. |
| D17LiquidityVault | function | `releaseCreatorTokens()` | nonpayable | permissionless_lifecycle | event_only | Anyone releases vested creator tokens to the fixed recipient (terminal Trading-stage button). |
| D17LiquidityVault | function | `router()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `routerFactory()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `sweepExcessWethToTreasury()` | nonpayable | public_recovery | event_only | Recovery for unexpected loose WETH donations only. |
| D17LiquidityVault | function | `sweepUnexpectedEthToTreasury()` | nonpayable | public_recovery | event_only | Recovery for unexpected native ETH only. |
| D17LiquidityVault | function | `token()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `tokenUsedForPool()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `treasury()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `vestedCreatorTokens()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `weth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | function | `wethUsedForPool()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17LiquidityVault | receive | `receive` | payable | safety_revert_surface | no | Rejects unsupported ETH/calls or exists as Solidity ABI surface. |
| D17Token | constructor | `constructor(address,string,string,uint256)` | nonpayable | deployment | no | Constructor used by deploy scripts only. |
| D17Token | event | `Approval(address,address,uint256)` | - | erc20_standard_wallet_dex | no | Required ERC-20 event; deliberately excluded from D17 mainnet activity indexing. |
| D17Token | event | `ContractURIUpdated()` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Token | event | `MintingClosed()` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Token | event | `OwnershipTransferred(address,address)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Token | event | `TokenMetadataConfigured(bytes32,string,string,string[],string[])` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Token | event | `TradingGateConfigured(address,address,address,address,address,uint256)` | - | indexer_api_activity | yes | D17 lifecycle event consumed by indexer/API/WS or deployment verification. |
| D17Token | event | `Transfer(address,address,uint256)` | - | erc20_standard_wallet_dex | no | Required ERC-20 event; deliberately excluded from D17 mainnet activity indexing. |
| D17Token | function | `D17_TOKEN_ID()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `allowance(address,address)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `approve(address,uint256)` | nonpayable | erc20_standard_wallet_dex | no | ERC-20/user token surface; not part of D17 lifecycle firehose indexing. |
| D17Token | function | `balanceOf(address)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `burn(uint256)` | nonpayable | erc20_standard_wallet_dex | no | ERC-20/user token surface; not part of D17 lifecycle firehose indexing. |
| D17Token | function | `canonicalPair()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `closeMinting()` | nonpayable | launch_factory_only | event_only | One-shot supply finalization. |
| D17Token | function | `configureMetadata(string,string,tuple[])` | nonpayable | launch_factory_only | event_only | One-shot metadata setup. |
| D17Token | function | `configureTradingGate(address,address,address,address,address,uint256)` | nonpayable | launch_factory_only | event_only | One-shot launch/vault/router gate setup. |
| D17Token | function | `contractURI()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `d17Factory()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `decimals()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `description()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `launch()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `linkCount()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `links(uint256)` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `liquidityVault()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `logoSvgUri()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `maxSupply()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `metadataConfigured()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `metadataHash()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `mint(address,uint256)` | nonpayable | launch_factory_only | erc20_transfer_excluded | Only before minting closes during launch deployment. |
| D17Token | function | `mintingClosed()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `name()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `owner()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `renounceOwnership()` | nonpayable | launch_factory_only | event_only | Per-token trust minimization after minting closes. |
| D17Token | function | `routerFactory()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `symbol()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `totalSupply()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `tradingGateConfigured()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `tradingOpen()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `tradingOpenAt()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
| D17Token | function | `transfer(address,uint256)` | nonpayable | erc20_standard_wallet_dex | no | ERC-20/user token surface; not part of D17 lifecycle firehose indexing. |
| D17Token | function | `transferFrom(address,address,uint256)` | nonpayable | erc20_standard_wallet_dex | no | ERC-20/user token surface; not part of D17 lifecycle firehose indexing. |
| D17Token | function | `weth()` | view | api_frontend_readonly_verification | no | Read-only getter used by API schema/detail, frontend display, scripts, or verification. |
