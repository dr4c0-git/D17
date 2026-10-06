// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {D17SafeTransfer} from "./lib/D17SafeTransfer.sol";
import {ID17FactoryView, IERC20BalanceView, IWETH} from "./interfaces/ID17.sol";

contract D17Launch {
    using D17SafeTransfer for address;

    bytes32 public constant D17_LAUNCH_ID = keccak256("D17_LAUNCH_V15_HARDENED");
    uint8 public constant ROUND_COUNT = 5;
    uint8 public constant FINAL_ROUND = 4;
    uint8 public constant REFUND_STAGE_COUNT = 4;
    // Contract rounds 0-1 refund at EARLY_REFUND_PENALTY_BPS, rounds 2-3 at the launch's
    // refundPenaltyBps; the final round has no normal refund window.
    uint8 public constant EARLY_REFUND_ROUNDS = 2;
    // Small fixed penalty on early refunds: makes "commit big, refund at the last second"
    // anchor griefing cost real money. Like every penalty it goes to the official pool
    // (or is burned if the launch fails), never to the creator or the protocol.
    uint16 public constant EARLY_REFUND_PENALTY_BPS = 100;
    uint8 public constant NO_ROUND = type(uint8).max;
    uint8 public constant PHASE_NOT_STARTED = 0;
    uint8 public constant PHASE_ROUND_OPEN = 1;
    uint8 public constant PHASE_REFUND_OPEN = 2;
    uint8 public constant PHASE_READY_TO_FINALIZE = 3;
    uint8 public constant PHASE_SETTLEMENT_OPEN = 4;
    uint8 public constant PHASE_POOL_READY = 5;
    uint8 public constant PHASE_TRADING_OPEN = 6;
    uint8 public constant PHASE_FAILED = 7;
    uint256 public constant BPS = 10_000;
    uint256 public constant MIN_COMMIT_WETH = 1e15;
    uint256 public constant MIN_LP_TOKENS = 1e18;
    uint256 public constant MIN_ROUND_ALLOCATION_TOKENS = 1e18;
    uint256 public constant MIN_ANCHOR_PRICE_WAD = 1e6;
    uint256 private constant WAD = 1e18;
    address public constant CANONICAL_DEAD_RECIPIENT = 0x000000000000000000000000000000000000dEaD;

    address public immutable factory;
    address public immutable vaultConfigurator;
    address public immutable token;
    address public immutable weth;
    address public immutable treasury;
    address public immutable protocolFeeRecipient;
    uint64 public immutable startTime;
    uint32 public immutable refundSeconds;
    uint32 public immutable settlementSeconds;
    uint256 public immutable tradingOpenAt;
    uint256 public immutable minCommitWeth;
    uint256 public immutable minPhase1Weth;
    uint256 public immutable minAnchorPriceWad;
    uint16 public immutable treasuryBps;
    uint16 public immutable protocolFeeBps;
    uint16 public immutable refundPenaltyBps;
    uint256 public immutable saleTokens;
    uint256 public immutable lpTokens;
    uint256 public immutable deadTokens;
    address public immutable deadRecipient;
    uint256 public immutable manualDistributionTokens;
    address public immutable manualDistributionRecipient;

    bytes32 public immutable metadataHash;

    address public liquidityVault;
    bool public liquidityPoolCreated;
    bool public vaultLiquidityClaimed;
    address public officialPair;
    uint256 public settledLiquidityWeth;
    uint256 public finalCommittedWeth;
    uint256 public settledCommittedWeth;
    uint256 public poolSettledLiquidityWeth;
    uint256 public poolSettledCommittedWeth;
    uint256 public lateSettledCommittedWeth;
    uint256 public lateSettledLiquidityWeth;
    uint256 public lateLpTokensReleased;
    uint256 public vaultLiquidityTokensClaimed;
    uint256 public officialTokenUsedForLp;
    uint256 public officialWethUsedForLp;
    uint256 public officialLpMinted;
    uint256 public poolCreatedAt;

    uint32[5] public roundSeconds;
    uint16[5] public roundSharesBps;
    uint256[5] public roundRaised;

    uint256 public retainedPenaltyWeth;
    uint256 public penaltyWethPaid;
    uint256 public treasuryWethPaid;
    uint256 public protocolFeeWethPaid;
    uint256 public unsoldSaleTokensSettled;
    uint256 public unusedLpTokensBurned;
    uint256 public effectiveLpTokens;
    uint256 public finalRoundTokenPool;
    bool public unsoldSaleTokensBurned;
    uint256 public finalizedAt;
    bool public finalized;
    uint256 private entered = 1;

    struct Position {
        bool finalSaleTokensClaimed;
        bool liquidityClaimed;
        uint256 refundWeth;
        uint256 penaltyWeth;
        uint256[5] paid;
        bool[5] refunded;
    }

    struct LaunchParams {
        address factory;
        address vaultConfigurator;
        address token;
        address weth;
        address treasury;
        address protocolFeeRecipient;
        bytes32 metadataHash;
        uint64 startTime;
        uint32[5] roundSeconds;
        uint32 refundSeconds;
        uint32 settlementSeconds;
        uint256 minCommitWeth;
        uint256 minPhase1Weth;
        uint256 minAnchorPriceWad;
        uint16[5] roundSharesBps;
        uint16 treasuryBps;
        uint16 protocolFeeBps;
        uint16 refundPenaltyBps;
        uint256 saleTokens;
        uint256 lpTokens;
        uint256 deadTokens;
        address deadRecipient;
        uint256 manualDistributionTokens;
        address manualDistributionRecipient;
    }

    mapping(address => Position) private positions;

    event LiquidityVaultConfigured(address indexed liquidityVault);
    event RoundCommitted(address indexed locker, uint8 indexed round, uint256 amount);
    event RoundRefunded(address indexed locker, uint8 indexed refundRound, uint256 refundWeth, uint256 penaltyWeth);
    event LaunchFailedRefunded(address indexed locker, uint256 refundWeth);
    event VaultSettlementClaimed(
        address indexed locker,
        uint256 saleTokens,
        uint256 wethForVault,
        uint256 treasuryWeth,
        uint256 protocolFeeWeth,
        uint256 grossCommittedWeth
    );
    event LateVaultSettlementClaimed(
        address indexed locker,
        uint256 saleTokens,
        uint256 wethForVault,
        uint256 treasuryWeth,
        uint256 protocolFeeWeth,
        uint256 lateLpTokens,
        uint256 grossCommittedWeth
    );
    event Finalized(uint256 finalizedAt);
    event VaultLiquidityTokensClaimed(
        address indexed liquidityVault,
        uint256 liquidityTokens,
        uint256 wethForPool
    );
    event LiquidityPoolCreated(
        address indexed liquidityVault,
        address indexed pair,
        uint256 tokenUsed,
        uint256 wethUsed,
        uint256 lpMinted
    );
    event UnsoldSaleTokensBurned(uint256 amount);
    event UnusedLpTokensBurned(uint256 amount);
    event ResidualTokensBurned(uint256 amount);
    event UnexpectedEthSwept(address indexed recipient, uint256 amount);

    modifier onlyLocker() {
        require(ID17FactoryView(factory).isLocker(msg.sender), "NOT_D17_LOCKER");
        _;
    }

    modifier onlyVault() {
        require(msg.sender == liquidityVault && liquidityVault != address(0), "NOT_LIQUIDITY_VAULT");
        _;
    }

    modifier nonReentrant() {
        require(entered == 1, "REENTRANT");
        entered = 2;
        _;
        entered = 1;
    }

    /// @dev Only D17LaunchDeployer (pinned to the canonical launch factory, which only the
    /// canonical D17Factory can drive after full config validation) creates launches, so the
    /// constructor keeps cheap structural checks; economic caps live in D17Factory.
    constructor(LaunchParams memory p) {
        require(p.factory != address(0), "FACTORY_ZERO");
        require(p.vaultConfigurator != address(0), "VAULT_CONFIG_ZERO");
        require(p.token != address(0), "TOKEN_ZERO");
        require(p.weth != address(0), "WETH_ZERO");
        require(p.treasury != address(0), "TREASURY_ZERO");
        require(p.protocolFeeBps == 0 || p.protocolFeeRecipient != address(0), "FEE_RECIPIENT_ZERO");
        require(uint256(p.treasuryBps) + p.protocolFeeBps < BPS, "FEE_BPS");
        require(p.refundPenaltyBps <= BPS, "REFUND_PENALTY_BPS");
        require(p.startTime >= block.timestamp, "START_PAST");
        require(p.refundSeconds > 0 && p.settlementSeconds > 0, "WINDOW_ZERO");
        require(p.minCommitWeth >= MIN_COMMIT_WETH, "MIN_COMMIT_TOO_LOW");
        require(p.minPhase1Weth >= p.minCommitWeth, "MIN_PHASE1_WETH");
        require(p.minAnchorPriceWad >= MIN_ANCHOR_PRICE_WAD, "MIN_ANCHOR_PRICE_TOO_LOW");
        require(p.saleTokens > 0, "SALE_ZERO");
        require(p.lpTokens >= MIN_LP_TOKENS, "LP_TOO_LOW");
        if (p.deadTokens > 0) require(p.deadRecipient == CANONICAL_DEAD_RECIPIENT, "DEAD_RECIPIENT");
        if (p.manualDistributionTokens > 0) {
            require(p.manualDistributionRecipient != address(0), "MANUAL_RECIPIENT_ZERO");
        }

        uint256 shareTotal;
        for (uint256 i; i < ROUND_COUNT; i++) {
            require(p.roundSeconds[i] > 0, "ROUND_SECONDS_ZERO");
            require(p.saleTokens * p.roundSharesBps[i] / BPS >= MIN_ROUND_ALLOCATION_TOKENS, "ROUND_ALLOCATION_TOO_LOW");
            roundSeconds[i] = p.roundSeconds[i];
            roundSharesBps[i] = p.roundSharesBps[i];
            shareTotal += p.roundSharesBps[i];
        }
        require(shareTotal == BPS, "ROUND_SHARE_TOTAL");

        factory = p.factory;
        vaultConfigurator = p.vaultConfigurator;
        token = p.token;
        weth = p.weth;
        treasury = p.treasury;
        protocolFeeRecipient = p.protocolFeeRecipient;
        metadataHash = p.metadataHash;
        startTime = p.startTime;
        refundSeconds = p.refundSeconds;
        settlementSeconds = p.settlementSeconds;
        tradingOpenAt = _roundEnd(ROUND_COUNT - 1, p.startTime, p.roundSeconds, p.refundSeconds) + p.settlementSeconds;
        minCommitWeth = p.minCommitWeth;
        minPhase1Weth = p.minPhase1Weth;
        minAnchorPriceWad = p.minAnchorPriceWad;
        treasuryBps = p.treasuryBps;
        protocolFeeBps = p.protocolFeeBps;
        refundPenaltyBps = p.refundPenaltyBps;
        saleTokens = p.saleTokens;
        lpTokens = p.lpTokens;
        deadTokens = p.deadTokens;
        deadRecipient = p.deadRecipient;
        manualDistributionTokens = p.manualDistributionTokens;
        manualDistributionRecipient = p.manualDistributionRecipient;
    }

    receive() external payable {
        revert("DIRECT_ETH_REJECTED");
    }

    fallback() external payable {
        revert("UNSUPPORTED_CALL");
    }

    function configureLiquidityVault(address liquidityVault_) external {
        require(msg.sender == vaultConfigurator, "NOT_VAULT_CONFIGURATOR");
        require(liquidityVault == address(0), "VAULT_CONFIGURED");
        require(liquidityVault_ != address(0), "VAULT_ZERO");
        require(liquidityVault_.code.length > 0, "VAULT_NO_CODE");
        liquidityVault = liquidityVault_;
        emit LiquidityVaultConfigured(liquidityVault_);
    }

    function rulesHash() public view returns (bytes32) {
        return keccak256(abi.encode(
            D17_LAUNCH_ID,
            factory,
            liquidityVault,
            token,
            weth,
            treasury,
            protocolFeeRecipient,
            startTime,
            refundSeconds,
            settlementSeconds,
            tradingOpenAt,
            minCommitWeth,
            minPhase1Weth,
            minAnchorPriceWad,
            roundSeconds,
            roundSharesBps,
            treasuryBps,
            protocolFeeBps,
            refundPenaltyBps,
            saleTokens,
            lpTokens,
            deadTokens,
            deadRecipient,
            manualDistributionTokens,
            manualDistributionRecipient,
            metadataHash
        ));
    }

    function activeRound() public view returns (uint8) {
        for (uint8 round; round < ROUND_COUNT; round++) {
            uint256 start = roundStart(round);
            if (block.timestamp >= start && block.timestamp < start + roundSeconds[round]) {
                if (round > 0 && !anchorReady()) return NO_ROUND;
                return round;
            }
        }
        return NO_ROUND;
    }

    function activeRefundWindow() public view returns (uint8) {
        for (uint8 round; round < REFUND_STAGE_COUNT; round++) {
            uint256 end = roundEnd(round);
            if (block.timestamp >= end && block.timestamp < end + refundSeconds) return round;
        }
        return NO_ROUND;
    }

    function roundStart(uint8 round) public view returns (uint256) {
        require(round < ROUND_COUNT, "ROUND");
        uint256 cursor = startTime;
        for (uint8 i; i < round; i++) {
            cursor += roundSeconds[i];
            if (i < REFUND_STAGE_COUNT) cursor += refundSeconds;
        }
        return cursor;
    }

    function roundEnd(uint8 round) public view returns (uint256) {
        return roundStart(round) + roundSeconds[round];
    }

    function roundBaseTokenAllocation(uint8 round) public view returns (uint256) {
        require(round < ROUND_COUNT, "ROUND");
        return saleTokens * roundSharesBps[round] / BPS;
    }

    function roundTokenAllocation(uint8 round) public view returns (uint256) {
        require(round < ROUND_COUNT, "ROUND");
        if (round == FINAL_ROUND) {
            return finalized ? finalRoundTokenPool : roundBaseTokenAllocation(FINAL_ROUND) + rolloverToFinalRound();
        }
        return roundBaseTokenAllocation(round);
    }

    function roundClaimTime(uint8 round) public view returns (uint256) {
        require(round < ROUND_COUNT, "ROUND");
        if (round < REFUND_STAGE_COUNT) return roundEnd(round) + refundSeconds;
        return roundEnd(round);
    }

    function anchorPriceWad() public view returns (uint256) {
        uint256 allocation = roundBaseTokenAllocation(0);
        if (allocation == 0 || roundRaised[0] == 0) return 0;
        return roundRaised[0] * WAD / allocation;
    }

    function anchorReady() public view returns (bool) {
        return roundRaised[0] >= minPhase1Weth && anchorPriceWad() >= minAnchorPriceWad;
    }

    function launchFailed() public view returns (bool) {
        return !finalized && block.timestamp >= roundEnd(0) + refundSeconds && !anchorReady();
    }

    /// @notice WETH needed for a round to sell its whole allocation at the phase-one anchor
    /// price. Applies to rounds 1-3 and, since V15, to the final round too: no round ever
    /// sells below the anchor price; the unsold remainder is burned at finalization.
    function roundAnchorTargetWeth(uint8 round) public view returns (uint256) {
        require(round < ROUND_COUNT, "ROUND");
        if (round == 0) return 0;
        return roundTokenAllocation(round) * anchorPriceWad() / WAD;
    }

    function roundAnchorUnderfillRemainingWeth(uint8 round) public view returns (uint256) {
        uint256 target = roundAnchorTargetWeth(round);
        if (roundRaised[round] >= target) return 0;
        return target - roundRaised[round];
    }

    function roundSoldTokens(uint8 round) public view returns (uint256) {
        require(round < ROUND_COUNT, "ROUND");
        uint256 raised = roundRaised[round];
        if (raised == 0) return 0;
        uint256 allocation = roundTokenAllocation(round);
        if (round == 0) return anchorReady() ? allocation : 0;

        uint256 target = roundAnchorTargetWeth(round);
        if (target == 0) return 0;
        if (raised >= target) return allocation;
        return allocation * raised / target;
    }

    function rolloverToFinalRound() public view returns (uint256 rolloverTokens) {
        for (uint8 round = 1; round < FINAL_ROUND; round++) {
            uint256 allocation = roundBaseTokenAllocation(round);
            uint256 sold = roundSoldTokens(round);
            if (allocation > sold) rolloverTokens += allocation - sold;
        }
    }

    function roundDiscoveredPriceWad(uint8 round) public view returns (uint256) {
        uint256 soldTokens = roundSoldTokens(round);
        if (soldTokens == 0) return 0;
        return roundRaised[round] * WAD / soldTokens;
    }

    function isRoundClaimable(uint8 round) public view returns (bool) {
        return block.timestamp >= roundClaimTime(round);
    }

    function settlementStartsAt() public view returns (uint256) {
        return roundEnd(FINAL_ROUND);
    }

    function poolCreationOpensAt() public view returns (uint256) {
        if (!finalized) return tradingOpenAt;
        uint256 finalizedDeadline = finalizedAt + settlementSeconds;
        return finalizedDeadline > tradingOpenAt ? finalizedDeadline : tradingOpenAt;
    }

    function tradingOpen() public view returns (bool) {
        return liquidityPoolCreated;
    }

    function totalCommittedWeth() public view returns (uint256 total) {
        for (uint8 round; round < ROUND_COUNT; round++) total += roundRaised[round];
    }

    /// @notice Share of every successful commitment that goes to the official pool.
    function liquidityBps() public view returns (uint256) {
        return BPS - treasuryBps - protocolFeeBps;
    }

    /// @notice Canonical pool WETH: the liquidity share of every final commitment plus all
    /// refund penalties (which are paid into the vault and paired at pool creation).
    function totalLiquidityWeth() public view returns (uint256) {
        uint256 committed = finalized ? finalCommittedWeth : totalCommittedWeth();
        return committed * liquidityBps() / BPS + retainedPenaltyWeth;
    }

    /// @notice LP tokens that will pair with totalLiquidityWeth(). Scaled to the share of the
    /// sale that actually sold, so the opening price tracks the average sale price (equal to
    /// it net of fees when lpTokens == saleTokens) instead of being set by an unsold
    /// allocation; the unused part is burned at finalization.
    function poolTokenAllocation() public view returns (uint256) {
        if (finalized) return effectiveLpTokens;
        return lpTokens * _soldSaleTokenAmount() / saleTokens;
    }

    /// @notice Read-only settlement-progress metric; it never gates lifecycle progress.
    function allFinalCommitmentsSettled() public view returns (bool) {
        return finalized && finalCommittedWeth > 0 && settledCommittedWeth == finalCommittedWeth;
    }

    function contributedBy(address locker, uint8 round) external view returns (uint256) {
        require(round < ROUND_COUNT, "ROUND");
        return positions[locker].paid[round];
    }

    function lockerPositionState(address locker)
        external
        view
        returns (
            bool liquidityClaimed,
            bool finalSaleTokensClaimed,
            uint256 refundWeth,
            uint256 penaltyWeth,
            bool[5] memory refunded
        )
    {
        Position storage position = positions[locker];
        return (
            position.liquidityClaimed,
            position.finalSaleTokensClaimed,
            position.refundWeth,
            position.penaltyWeth,
            position.refunded
        );
    }

    function previewRoundTokens(address locker, uint8 round) public view returns (uint256 saleTokenAmount) {
        require(round < ROUND_COUNT, "ROUND");
        Position storage position = positions[locker];
        if (position.finalSaleTokensClaimed || position.refunded[round]) return 0;
        uint256 paid = position.paid[round];
        if (paid == 0) return 0;
        return _roundTokensForBuyer(round, paid);
    }

    function previewFinalSaleTokens(address locker) public view returns (uint256 saleTokenAmount) {
        Position storage position = positions[locker];
        if (position.finalSaleTokensClaimed) return 0;
        for (uint8 round; round < ROUND_COUNT; round++) saleTokenAmount += previewRoundTokens(locker, round);
    }

    function previewVaultSettlement(address locker)
        public
        view
        returns (
            uint256 saleTokenAmount,
            uint256 grossCommittedWeth,
            uint256 wethForVault,
            uint256 treasuryWeth,
            uint256 protocolFeeWeth
        )
    {
        Position storage position = positions[locker];
        if (position.liquidityClaimed) return (0, 0, 0, 0, 0);
        saleTokenAmount = previewFinalSaleTokens(locker);
        (grossCommittedWeth, wethForVault, treasuryWeth, protocolFeeWeth) = _vaultSettlementAmounts(position);
    }

    function launchPhase()
        external
        view
        returns (uint8 phaseKind, uint8 index, uint256 startsAt, uint256 endsAt)
    {
        if (finalized && liquidityPoolCreated) {
            return (PHASE_TRADING_OPEN, NO_ROUND, poolCreatedAt, type(uint256).max);
        }
        if (finalized && block.timestamp < poolCreationOpensAt()) {
            return (PHASE_SETTLEMENT_OPEN, NO_ROUND, finalizedAt, poolCreationOpensAt());
        }
        if (finalized) {
            return (PHASE_POOL_READY, NO_ROUND, poolCreationOpensAt(), type(uint256).max);
        }
        if (block.timestamp < startTime) return (PHASE_NOT_STARTED, NO_ROUND, startTime, startTime);
        if (launchFailed()) return (PHASE_FAILED, NO_ROUND, roundEnd(0) + refundSeconds, type(uint256).max);

        uint8 round = activeRound();
        if (round != NO_ROUND) return (PHASE_ROUND_OPEN, round, roundStart(round), roundEnd(round));

        uint8 refundWindow = activeRefundWindow();
        if (refundWindow != NO_ROUND) {
            uint256 refundStart = roundEnd(refundWindow);
            return (PHASE_REFUND_OPEN, refundWindow, refundStart, refundStart + refundSeconds);
        }

        if (block.timestamp >= roundEnd(ROUND_COUNT - 1)) {
            uint256 finalRoundEnd = roundEnd(ROUND_COUNT - 1);
            return (PHASE_READY_TO_FINALIZE, NO_ROUND, finalRoundEnd, poolCreationOpensAt());
        }

        return (PHASE_NOT_STARTED, NO_ROUND, startTime, startTime);
    }

    function recordRoundCommitment(uint8 round, uint256 amount) external onlyLocker nonReentrant {
        require(round < ROUND_COUNT, "ROUND");
        require(amount >= minCommitWeth, "COMMIT_TOO_SMALL");
        require(round == activeRound(), "ROUND_CLOSED");
        if (round > 0) require(anchorReady(), "ANCHOR_NOT_READY");

        Position storage position = positions[msg.sender];
        require(!position.liquidityClaimed, "LIQUIDITY_CLAIMED");
        require(!position.refunded[round], "ROUND_REFUNDED");
        require(!position.finalSaleTokensClaimed, "SALE_TOKENS_CLAIMED");

        position.paid[round] += amount;
        roundRaised[round] += amount;
        emit RoundCommitted(msg.sender, round, amount);
    }

    function releaseRoundRefund()
        external
        onlyLocker
        nonReentrant
        returns (uint8 round, uint256 refundWeth, uint256 penaltyWeth)
    {
        round = activeRefundWindow();
        require(round != NO_ROUND, "NO_REFUND_STAGE");

        Position storage position = positions[msg.sender];
        require(!position.liquidityClaimed, "LIQUIDITY_CLAIMED");
        require(!position.refunded[round], "ROUND_REFUNDED");
        require(!position.finalSaleTokensClaimed, "SALE_TOKENS_CLAIMED");

        uint256 gross = position.paid[round];
        require(gross > 0, "NO_ROUND_POSITION");

        roundRaised[round] -= gross;
        position.paid[round] = 0;
        position.refunded[round] = true;

        // Refund schedule [early, early, launch, launch, no-window]. The locker pays the
        // penalty into the liquidity vault: it deepens the official pool (or is burned if
        // the launch fails). Neither the creator's treasury nor the protocol receives it.
        penaltyWeth = gross * (round < EARLY_REFUND_ROUNDS ? EARLY_REFUND_PENALTY_BPS : refundPenaltyBps) / BPS;
        refundWeth = gross - penaltyWeth;
        retainedPenaltyWeth += penaltyWeth;
        penaltyWethPaid += penaltyWeth;
        position.refundWeth += refundWeth;
        position.penaltyWeth += penaltyWeth;

        emit RoundRefunded(msg.sender, round, refundWeth, penaltyWeth);
    }

    function releaseFailedRefund() external onlyLocker nonReentrant returns (uint256 refundWeth) {
        require(launchFailed(), "LAUNCH_NOT_FAILED");

        Position storage position = positions[msg.sender];
        require(!position.liquidityClaimed, "LIQUIDITY_CLAIMED");
        require(!position.finalSaleTokensClaimed, "SALE_TOKENS_CLAIMED");

        for (uint8 round; round < ROUND_COUNT; round++) {
            uint256 paid = position.paid[round];
            if (paid == 0) continue;
            roundRaised[round] -= paid;
            position.paid[round] = 0;
            position.refunded[round] = true;
            refundWeth += paid;
        }

        require(refundWeth > 0, "NO_POSITION");
        position.refundWeth += refundWeth;
        emit LaunchFailedRefunded(msg.sender, refundWeth);
    }

    function claimVaultSettlement()
        external
        onlyLocker
        nonReentrant
        returns (uint256 saleTokenAmount, uint256 wethForVault, uint256 treasuryWeth, uint256 protocolFeeWeth)
    {
        require(!liquidityPoolCreated, "POOL_CREATED");
        (saleTokenAmount, wethForVault, treasuryWeth, protocolFeeWeth, ) = _settlePosition(false);
    }

    /// @notice Settlement for lockers that missed pool creation: the exact finalized sale
    /// tokens for the exact same WETH cost and fees. The position's LP-share WETH and its
    /// share of the reserved LP tokens are sent to the vault, which adds them to the official
    /// pair at the pair's current ratio in the same transaction. Callable forever.
    function claimLateSettlement()
        external
        onlyLocker
        nonReentrant
        returns (
            uint256 saleTokenAmount,
            uint256 wethForVault,
            uint256 treasuryWeth,
            uint256 protocolFeeWeth,
            uint256 lateLpTokens
        )
    {
        require(liquidityPoolCreated, "POOL_NOT_CREATED");
        return _settlePosition(true);
    }

    function _settlePosition(bool late)
        internal
        returns (
            uint256 saleTokenAmount,
            uint256 wethForVault,
            uint256 treasuryWeth,
            uint256 protocolFeeWeth,
            uint256 lateLpTokens
        )
    {
        require(liquidityVault != address(0), "VAULT_NOT_CONFIGURED");
        if (!finalized) _finalizeLaunch();

        Position storage position = positions[msg.sender];
        require(!position.liquidityClaimed, "LIQUIDITY_CLAIMED");
        require(!position.finalSaleTokensClaimed, "SALE_TOKENS_CLAIMED");
        saleTokenAmount = previewFinalSaleTokens(msg.sender);
        uint256 grossCommittedWeth;
        (grossCommittedWeth, wethForVault, treasuryWeth, protocolFeeWeth) = _vaultSettlementAmounts(position);
        require(grossCommittedWeth > 0, "NO_POSITION");

        position.liquidityClaimed = true;
        position.finalSaleTokensClaimed = true;
        settledCommittedWeth += grossCommittedWeth;
        treasuryWethPaid += treasuryWeth;
        protocolFeeWethPaid += protocolFeeWeth;

        if (late) {
            // Per-position fee rounding means the per-position liquidity shares can sum to a
            // few wei above totalLiquidityWeth(); capping at the remaining reserve keeps the
            // last late settler from ever being blocked by that rounding.
            uint256 reserve = effectiveLpTokens - vaultLiquidityTokensClaimed - lateLpTokensReleased;
            lateLpTokens = effectiveLpTokens * wethForVault / totalLiquidityWeth();
            if (lateLpTokens > reserve) lateLpTokens = reserve;
            lateSettledCommittedWeth += grossCommittedWeth;
            lateSettledLiquidityWeth += wethForVault;
            lateLpTokensReleased += lateLpTokens;
            if (lateLpTokens > 0) token.safeTransfer(liquidityVault, lateLpTokens);
            emit LateVaultSettlementClaimed(
                msg.sender,
                saleTokenAmount,
                wethForVault,
                treasuryWeth,
                protocolFeeWeth,
                lateLpTokens,
                grossCommittedWeth
            );
        } else {
            settledLiquidityWeth += wethForVault;
            emit VaultSettlementClaimed(
                msg.sender, saleTokenAmount, wethForVault, treasuryWeth, protocolFeeWeth, grossCommittedWeth
            );
        }

        if (saleTokenAmount > 0) token.safeTransfer(msg.sender, saleTokenAmount);
    }

    function finalizeLaunch() external nonReentrant {
        _finalizeLaunch();
    }

    function claimVaultLiquidityTokens()
        external
        onlyVault
        nonReentrant
        returns (uint256 liquidityTokens, uint256 wethForPool)
    {
        if (!finalized) _finalizeLaunch();
        require(!liquidityPoolCreated, "POOL_CREATED");
        require(!vaultLiquidityClaimed, "VAULT_LIQUIDITY_CLAIMED");
        require(block.timestamp >= poolCreationOpensAt(), "POOL_CREATION_NOT_OPEN");
        require(settledLiquidityWeth > 0, "NO_SETTLED_LIQUIDITY");

        // The initial pool pairs the settled WETH plus every refund penalty with the
        // proportional share of the LP token allocation, so it opens at the canonical ratio
        // (poolTokenAllocation : totalLiquidityWeth). The rest stays reserved for late settlers.
        wethForPool = settledLiquidityWeth + retainedPenaltyWeth;
        liquidityTokens = effectiveLpTokens * wethForPool / totalLiquidityWeth();
        require(liquidityTokens > 0, "NO_LIQUIDITY_TOKENS");

        vaultLiquidityClaimed = true;
        vaultLiquidityTokensClaimed = liquidityTokens;
        poolSettledLiquidityWeth = settledLiquidityWeth;
        poolSettledCommittedWeth = settledCommittedWeth;
        token.safeTransfer(liquidityVault, liquidityTokens);

        emit VaultLiquidityTokensClaimed(liquidityVault, liquidityTokens, wethForPool);
    }

    function markLiquidityPoolCreated(address pair, uint256 tokenUsed, uint256 wethUsed, uint256 lpMinted)
        external
        onlyVault
        nonReentrant
    {
        require(!liquidityPoolCreated, "POOL_CREATED");
        require(vaultLiquidityClaimed, "VAULT_LIQUIDITY_NOT_CLAIMED");
        require(pair != address(0), "PAIR_ZERO");
        require(tokenUsed == vaultLiquidityTokensClaimed, "TOKEN_USED_MISMATCH");
        require(wethUsed == poolSettledLiquidityWeth + retainedPenaltyWeth, "WETH_USED_MISMATCH");
        require(lpMinted > 0, "LP_ZERO");

        liquidityPoolCreated = true;
        officialPair = pair;
        officialTokenUsedForLp = tokenUsed;
        officialWethUsedForLp = wethUsed;
        officialLpMinted = lpMinted;
        poolCreatedAt = block.timestamp;

        emit LiquidityPoolCreated(liquidityVault, pair, tokenUsed, wethUsed, lpMinted);
    }

    /// @notice Once every final commitment has settled, whatever the launch still holds is
    /// per-position rounding dust (sale and reserved LP tokens). Anyone may burn it.
    function burnResidualTokens() external nonReentrant returns (uint256 amount) {
        require(liquidityPoolCreated && allFinalCommitmentsSettled(), "SETTLEMENT_OPEN");
        amount = IERC20BalanceView(token).balanceOf(address(this));
        require(amount > 0, "NO_RESIDUAL");
        token.safeBurn(amount);
        emit ResidualTokensBurned(amount);
    }

    /// @notice Forced ETH (selfdestruct / coinbase) is wrapped and sent as WETH, so a
    /// treasury that rejects ETH cannot block the sweep.
    function sweepUnexpectedEthToTreasury() external nonReentrant returns (uint256 amount) {
        amount = address(this).balance;
        require(amount > 0, "NO_ETH_BALANCE");
        IWETH(weth).deposit{value: amount}();
        weth.safeTransfer(treasury, amount);
        emit UnexpectedEthSwept(treasury, amount);
    }

    function _finalizeLaunch() internal {
        require(!finalized, "FINALIZED");
        require(!launchFailed(), "LAUNCH_FAILED");
        require(block.timestamp >= roundEnd(ROUND_COUNT - 1), "NOT_OVER");

        finalized = true;
        finalizedAt = block.timestamp;
        finalRoundTokenPool = roundBaseTokenAllocation(FINAL_ROUND) + rolloverToFinalRound();
        finalCommittedWeth = totalCommittedWeth();
        // Canonical launches only reach finalization after the phase-one anchor made total
        // commitments nonzero; keep the explicit guard against finalizing an empty launch.
        require(finalCommittedWeth > 0, "NO_FINAL_COMMITMENTS");

        uint256 soldSaleTokens = _soldSaleTokenAmount();
        unsoldSaleTokensSettled = saleTokens - soldSaleTokens;
        effectiveLpTokens = lpTokens * soldSaleTokens / saleTokens;
        unusedLpTokensBurned = lpTokens - effectiveLpTokens;

        // Unsold sale tokens and the unused LP allocation are always burned: no wallet,
        // including the creator's treasury, ever receives tokens the market did not buy.
        if (unsoldSaleTokensSettled + unusedLpTokensBurned > 0) {
            token.safeBurn(unsoldSaleTokensSettled + unusedLpTokensBurned);
        }
        if (unsoldSaleTokensSettled > 0) {
            unsoldSaleTokensBurned = true;
            emit UnsoldSaleTokensBurned(unsoldSaleTokensSettled);
        }
        if (unusedLpTokensBurned > 0) emit UnusedLpTokensBurned(unusedLpTokensBurned);

        emit Finalized(finalizedAt);
    }

    function _vaultSettlementAmounts(Position storage position)
        internal
        view
        returns (uint256 grossCommittedWeth, uint256 wethForVault, uint256 treasuryWeth, uint256 protocolFeeWeth)
    {
        for (uint8 round; round < ROUND_COUNT; round++) grossCommittedWeth += position.paid[round];
        if (grossCommittedWeth == 0) return (0, 0, 0, 0);

        treasuryWeth = grossCommittedWeth * treasuryBps / BPS;
        protocolFeeWeth = grossCommittedWeth * protocolFeeBps / BPS;
        wethForVault = grossCommittedWeth - treasuryWeth - protocolFeeWeth;
    }

    function _roundTokensForBuyer(uint8 round, uint256 paid) internal view returns (uint256) {
        if (paid == 0) return 0;
        if (roundRaised[round] == 0) return 0;
        if (round == 0) {
            if (!anchorReady()) return 0;
            return roundBaseTokenAllocation(0) * paid / roundRaised[round];
        }

        uint256 sold = roundSoldTokens(round);
        if (sold == 0) return 0;
        return sold * paid / roundRaised[round];
    }

    function _soldSaleTokenAmount() internal view returns (uint256 soldSaleTokens) {
        for (uint8 round; round < ROUND_COUNT; round++) soldSaleTokens += roundSoldTokens(round);
        if (soldSaleTokens > saleTokens) return saleTokens;
    }

    function _roundEnd(uint8 round, uint256 start, uint32[5] memory durations, uint32 refundDuration)
        private
        pure
        returns (uint256)
    {
        uint256 cursor = start;
        for (uint8 i; i < round; i++) {
            cursor += durations[i];
            if (i < REFUND_STAGE_COUNT) cursor += refundDuration;
        }
        return cursor + durations[round];
    }
}
