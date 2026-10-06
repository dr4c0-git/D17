// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ID17Launch {
    function D17_LAUNCH_ID() external view returns (bytes32);
    function rulesHash() external view returns (bytes32);
    function metadataHash() external view returns (bytes32);
    function token() external view returns (address);
    function weth() external view returns (address);
    function treasury() external view returns (address);
    function protocolFeeRecipient() external view returns (address);
    function launchFailed() external view returns (bool);
    function factory() external view returns (address);
    function liquidityVault() external view returns (address);
    function tradingOpenAt() external view returns (uint256);
    function tradingOpen() external view returns (bool);
    function liquidityPoolCreated() external view returns (bool);
    function settlementStartsAt() external view returns (uint256);
    function settlementSeconds() external view returns (uint32);
    function poolCreationOpensAt() external view returns (uint256);
    function settledLiquidityWeth() external view returns (uint256);
    function poolSettledLiquidityWeth() external view returns (uint256);
    function poolSettledCommittedWeth() external view returns (uint256);
    function lateSettledCommittedWeth() external view returns (uint256);
    function lateSettledLiquidityWeth() external view returns (uint256);
    function manualDistributionTokens() external view returns (uint256);
    function manualDistributionRecipient() external view returns (address);
    function activeRound() external view returns (uint8);
    function activeRefundWindow() external view returns (uint8);
    function finalized() external view returns (bool);
    function allFinalCommitmentsSettled() external view returns (bool);
    function anchorPriceWad() external view returns (uint256);
    function roundBaseTokenAllocation(uint8 round) external view returns (uint256);
    function roundTokenAllocation(uint8 round) external view returns (uint256);
    function roundSoldTokens(uint8 round) external view returns (uint256);
    function roundAnchorTargetWeth(uint8 round) external view returns (uint256);
    function roundAnchorUnderfillRemainingWeth(uint8 round) external view returns (uint256);
    function recordRoundCommitment(uint8 round, uint256 amount) external;
    function releaseRoundRefund() external returns (uint8 round, uint256 refundWeth, uint256 penaltyWeth);
    function releaseFailedRefund() external returns (uint256 refundWeth);
    function claimVaultSettlement()
        external
        returns (uint256 saleTokens, uint256 wethForVault, uint256 treasuryWeth, uint256 protocolFeeWeth);
    function claimLateSettlement()
        external
        returns (
            uint256 saleTokens,
            uint256 wethForVault,
            uint256 treasuryWeth,
            uint256 protocolFeeWeth,
            uint256 lateLpTokens
        );
    function finalizeLaunch() external;
    function claimVaultLiquidityTokens() external returns (uint256 liquidityTokens, uint256 wethForPool);
    function markLiquidityPoolCreated(address pair, uint256 tokenUsed, uint256 wethUsed, uint256 lpMinted) external;
    function previewRoundTokens(address locker, uint8 round) external view returns (uint256 saleTokens);
    function previewFinalSaleTokens(address locker) external view returns (uint256 saleTokens);
    function previewVaultSettlement(address locker)
        external
        view
        returns (
            uint256 saleTokens,
            uint256 grossCommittedWeth,
            uint256 wethForVault,
            uint256 treasuryWeth,
            uint256 protocolFeeWeth
        );
}

interface ID17VaultLateLiquidity {
    function mintLateLiquidity(uint256 tokenAmount, uint256 wethAmount) external returns (uint256 liquidity);
}

interface ID17FactoryView {
    function isLocker(address locker) external view returns (bool);
    function isCanonicalLaunch(address launch, bytes32 rulesHash) external view returns (bool);
}

interface IWETH {
    function deposit() external payable;
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC20BalanceView {
    function balanceOf(address account) external view returns (uint256);
}

interface IV2Router {
    function factory() external view returns (address);
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
}

interface IV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IV2PairView {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function totalSupply() external view returns (uint256);
    function mint(address to) external returns (uint256 liquidity);
    function balanceOf(address account) external view returns (uint256);
}

interface ID17TokenTradingGateLaunch {
    function tradingOpen() external view returns (bool);
}
