// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {D17SafeTransfer} from "./lib/D17SafeTransfer.sol";
import {ID17FactoryView, ID17Launch, ID17VaultLateLiquidity, IWETH} from "./interfaces/ID17.sol";

contract D17Locker {
    using D17SafeTransfer for address;

    bytes32 public constant EXPECTED_LAUNCH_ID = keccak256("D17_LAUNCH_V15_HARDENED");
    uint8 public constant ROUND_COUNT = 5;

    address public immutable owner;
    address public immutable factory;
    address public immutable weth;

    uint256 public withdrawableWeth;
    uint256 public accountedWeth;
    uint256 private entered = 1;

    struct LockerPosition {
        bool known;
        bool liquiditySettled;
        address token;
        address liquidityVault;
        bytes32 rulesHash;
        uint256 ethCommitted;
        uint256 wethCommitted;
        uint256 wethRefunded;
        uint256 penaltyPaid;
        uint256 claimedSaleTokens;
        uint256 wethSentToVault;
        uint256 wethForLp;
        uint256 treasuryWeth;
        uint256 protocolFeeWeth;
        uint256 withdrawableTokens;
        uint256 residualWeth;
        bool finalSaleTokensClaimed;
        uint256[5] roundWeth;
        uint256[5] roundSaleTokens;
        bool[5] roundRefunded;
        bool[5] roundTokensClaimed;
    }

    mapping(address => LockerPosition) public positions;

    event RoundCommitted(address indexed launch, uint8 indexed round, uint256 amount);
    event RoundRefunded(address indexed launch, uint8 indexed round, uint256 refundWeth, uint256 penaltyWeth);
    event WethWithdrawn(address indexed launch, uint256 amount);
    event VaultSettlementCompleted(
        address indexed launch,
        address indexed liquidityVault,
        address indexed settler,
        address owner,
        uint256 saleTokens,
        uint256 wethSentToVault,
        uint256 treasuryWeth,
        uint256 protocolFeeWeth,
        uint256 grossCommittedWeth,
        uint256 residualWeth
    );
    event ClaimedTokensWithdrawn(address indexed launch, uint256 amount);
    event FailedLaunchRefunded(address indexed launch, uint256 refundWeth);
    event NativeEthRecovered(address indexed recipient, uint256 amount);
    event ExcessWethRecovered(address indexed recipient, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier nonReentrant() {
        require(entered == 1, "REENTRANT");
        entered = 2;
        _;
        entered = 1;
    }

    constructor(address owner_, address factory_, address weth_) {
        require(owner_ != address(0), "OWNER_ZERO");
        require(factory_ != address(0), "FACTORY_ZERO");
        require(weth_ != address(0), "WETH_ZERO");
        owner = owner_;
        factory = factory_;
        weth = weth_;
    }

    receive() external payable {
        revert("DIRECT_ETH_REJECTED");
    }

    fallback() external payable {
        revert("UNSUPPORTED_CALL");
    }

    function verifyLaunch(address launch, bytes32 expectedRulesHash) public view returns (bool) {
        require(launch.code.length > 0, "NO_CODE");
        ID17Launch candidate = ID17Launch(launch);
        require(candidate.D17_LAUNCH_ID() == EXPECTED_LAUNCH_ID, "BAD_LAUNCH_ID");
        require(candidate.weth() == weth, "BAD_WETH");
        require(candidate.rulesHash() == expectedRulesHash, "BAD_RULES");
        require(ID17FactoryView(factory).isCanonicalLaunch(launch, expectedRulesHash), "NOT_CANONICAL");
        return true;
    }

    function lockedWeth(address launch) external view returns (uint256) {
        return positions[launch].wethCommitted;
    }

    function roundPosition(address launch, uint8 round)
        external
        view
        returns (uint256 roundWeth, uint256 roundSaleTokens, bool refunded, bool tokensClaimed)
    {
        require(round < ROUND_COUNT, "ROUND");
        LockerPosition storage position = positions[launch];
        return (
            position.roundWeth[round],
            position.roundSaleTokens[round],
            position.roundRefunded[round],
            position.roundTokensClaimed[round]
        );
    }

    function commitToRound(address launch, uint8 round, bytes32 expectedRulesHash)
        public
        payable
        onlyOwner
        nonReentrant
    {
        require(msg.value > 0, "NO_ETH");
        require(round < ROUND_COUNT, "ROUND");
        verifyLaunch(launch, expectedRulesHash);

        LockerPosition storage position = positions[launch];
        require(!position.liquiditySettled, "LIQUIDITY_SETTLED");

        IWETH(weth).deposit{value: msg.value}();
        accountedWeth += msg.value;

        position.known = true;
        position.rulesHash = expectedRulesHash;
        position.token = ID17Launch(launch).token();
        position.ethCommitted += msg.value;
        position.wethCommitted += msg.value;
        position.roundWeth[round] += msg.value;

        ID17Launch(launch).recordRoundCommitment(round, msg.value);
        emit RoundCommitted(launch, round, msg.value);
    }

    function refundCurrentRound(address launch) public onlyOwner nonReentrant {
        LockerPosition storage position = positions[launch];
        require(position.known, "UNKNOWN_LAUNCH");
        require(!position.liquiditySettled, "LIQUIDITY_SETTLED");

        (uint8 round, uint256 refundWeth, uint256 penaltyWeth) = ID17Launch(launch).releaseRoundRefund();
        uint256 gross = refundWeth + penaltyWeth;
        require(gross > 0, "NO_REFUND");
        require(position.roundWeth[round] >= gross, "ROUND_WETH_BALANCE");
        require(position.wethCommitted >= gross, "LOCKED_WETH_BALANCE");

        position.roundWeth[round] -= gross;
        position.wethCommitted -= gross;
        position.roundRefunded[round] = true;
        position.wethRefunded += refundWeth;
        position.penaltyPaid += penaltyWeth;
        position.residualWeth += refundWeth;
        withdrawableWeth += refundWeth;
        if (penaltyWeth > 0) accountedWeth -= penaltyWeth;

        // Penalties deepen the official pool (vault), they never reach the creator.
        if (penaltyWeth > 0) weth.safeTransfer(ID17Launch(launch).liquidityVault(), penaltyWeth);
        emit RoundRefunded(launch, round, refundWeth, penaltyWeth);
    }

    function withdrawUnlockedWeth(address launch, uint256 amount) public onlyOwner nonReentrant {
        require(amount > 0, "AMOUNT_ZERO");
        LockerPosition storage position = positions[launch];
        require(amount <= position.residualWeth, "POSITION_WETH_BALANCE");
        require(amount <= withdrawableWeth, "WETH_BALANCE");
        position.residualWeth -= amount;
        withdrawableWeth -= amount;
        accountedWeth -= amount;
        weth.safeTransfer(owner, amount);
        emit WethWithdrawn(launch, amount);
    }

    function refundFailedLaunch(address launch, bytes32 expectedRulesHash) public onlyOwner nonReentrant {
        verifyLaunch(launch, expectedRulesHash);
        LockerPosition storage position = positions[launch];
        require(position.known, "UNKNOWN_LAUNCH");
        require(!position.liquiditySettled, "LIQUIDITY_SETTLED");

        uint256 localRefund;
        for (uint8 round; round < ROUND_COUNT; round++) localRefund += position.roundWeth[round];

        uint256 refundWeth = ID17Launch(launch).releaseFailedRefund();
        require(refundWeth == localRefund, "FAILED_REFUND_MISMATCH");
        require(position.wethCommitted >= refundWeth, "LOCKED_WETH_BALANCE");

        for (uint8 round; round < ROUND_COUNT; round++) {
            if (position.roundWeth[round] > 0) {
                position.roundWeth[round] = 0;
                position.roundRefunded[round] = true;
            }
        }

        position.wethCommitted -= refundWeth;
        position.wethRefunded += refundWeth;
        position.residualWeth += refundWeth;
        withdrawableWeth += refundWeth;
        emit FailedLaunchRefunded(launch, refundWeth);
    }

    function settleAndClaim(address launch, bytes32 expectedRulesHash) public onlyOwner nonReentrant returns (uint256 claimedSaleTokens) {
        verifyLaunch(launch, expectedRulesHash);
        claimedSaleTokens = _settleVaultPosition(launch);
    }

    function settleAfterGrace(address launch) public nonReentrant returns (uint256 claimedSaleTokens) {
        LockerPosition storage position = positions[launch];
        require(position.known, "UNKNOWN_LAUNCH");
        verifyLaunch(launch, position.rulesHash);
        require(ID17Launch(launch).finalized(), "NOT_FINALIZED");
        require(block.timestamp >= ID17Launch(launch).poolCreationOpensAt(), "GRACE_OPEN");
        claimedSaleTokens = _settleVaultPosition(launch);
    }

    function _settleVaultPosition(address launch) internal returns (uint256 claimedSaleTokens) {
        LockerPosition storage position = positions[launch];
        require(position.known, "UNKNOWN_LAUNCH");
        require(!position.liquiditySettled, "LIQUIDITY_SETTLED");

        uint256 previewTotal;
        uint256 grossCommittedWeth;
        for (uint8 round; round < ROUND_COUNT; round++) {
            uint256 roundAmount = ID17Launch(launch).previewRoundTokens(address(this), round);
            position.roundSaleTokens[round] = roundAmount;
            if (roundAmount > 0) position.roundTokensClaimed[round] = true;
            previewTotal += roundAmount;
            grossCommittedWeth += position.roundWeth[round];
        }

        // After pool creation the launch routes settlement through the late top-up path:
        // identical sale tokens, WETH cost, and fee, with the LP-share WETH still entering
        // the official pool alongside the position's reserved LP-token share.
        bool late = ID17Launch(launch).liquidityPoolCreated();
        uint256 wethForVault;
        uint256 treasuryWeth;
        uint256 protocolFeeWeth;
        uint256 lateLpTokens;
        if (late) {
            (claimedSaleTokens, wethForVault, treasuryWeth, protocolFeeWeth, lateLpTokens) =
                ID17Launch(launch).claimLateSettlement();
        } else {
            (claimedSaleTokens, wethForVault, treasuryWeth, protocolFeeWeth) = ID17Launch(launch).claimVaultSettlement();
        }
        require(claimedSaleTokens == previewTotal, "FINAL_CLAIM_MISMATCH");
        uint256 spent = wethForVault + treasuryWeth + protocolFeeWeth;
        require(position.wethCommitted >= spent, "LOCKED_WETH_BALANCE");

        position.liquiditySettled = true;
        position.finalSaleTokensClaimed = true;
        position.claimedSaleTokens += claimedSaleTokens;
        position.withdrawableTokens += claimedSaleTokens;
        position.liquidityVault = ID17Launch(launch).liquidityVault();
        position.wethSentToVault = wethForVault;
        position.wethForLp = wethForVault;
        position.treasuryWeth = treasuryWeth;
        position.protocolFeeWeth = protocolFeeWeth;
        position.token = ID17Launch(launch).token();
        position.wethCommitted -= spent;

        if (wethForVault > 0) weth.safeTransfer(position.liquidityVault, wethForVault);
        if (treasuryWeth > 0) weth.safeTransfer(ID17Launch(launch).treasury(), treasuryWeth);
        if (protocolFeeWeth > 0) weth.safeTransfer(ID17Launch(launch).protocolFeeRecipient(), protocolFeeWeth);
        accountedWeth -= spent;

        if (late) {
            ID17VaultLateLiquidity(position.liquidityVault).mintLateLiquidity(lateLpTokens, wethForVault);
        }

        position.residualWeth += position.wethCommitted;
        withdrawableWeth += position.wethCommitted;
        position.wethCommitted = 0;

        emit VaultSettlementCompleted(
            launch,
            position.liquidityVault,
            msg.sender,
            owner,
            claimedSaleTokens,
            wethForVault,
            treasuryWeth,
            protocolFeeWeth,
            grossCommittedWeth,
            position.residualWeth
        );
    }

    function withdrawUnlockedTokens(address launch, uint256 amount) public onlyOwner nonReentrant {
        require(amount > 0, "AMOUNT_ZERO");
        LockerPosition storage position = positions[launch];
        require(position.token != address(0), "TOKEN_MISSING");
        require(ID17Launch(launch).tradingOpen(), "TOKEN_WITHDRAW_LOCKED");
        require(amount <= position.withdrawableTokens, "TOKEN_BALANCE");
        position.withdrawableTokens -= amount;
        position.token.safeTransfer(owner, amount);
        emit ClaimedTokensWithdrawn(launch, amount);
    }

    function recoverNativeEth(address recipient, uint256 amount) external onlyOwner nonReentrant {
        require(recipient != address(0), "RECIPIENT_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        require(amount <= address(this).balance, "ETH_BALANCE");
        (bool ok, ) = recipient.call{value: amount}("");
        require(ok, "ETH_TRANSFER_FAILED");
        emit NativeEthRecovered(recipient, amount);
    }

    function recoverExcessWeth(address recipient, uint256 amount) public onlyOwner nonReentrant {
        require(recipient != address(0), "RECIPIENT_ZERO");
        require(amount > 0, "AMOUNT_ZERO");
        uint256 balance = IWETH(weth).balanceOf(address(this));
        require(balance > accountedWeth, "NO_EXCESS_WETH");
        require(amount <= balance - accountedWeth, "EXCESS_WETH_BALANCE");
        weth.safeTransfer(recipient, amount);
        emit ExcessWethRecovered(recipient, amount);
    }

}
