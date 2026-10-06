// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {D17SafeTransfer} from "./lib/D17SafeTransfer.sol";
import {ID17FactoryView, ID17Launch, IERC20BalanceView, IV2Factory, IV2PairView, IV2Router, IWETH} from "./interfaces/ID17.sol";

/// @notice Owns the official pair's LP forever (there is no LP withdrawal path), pairs the
/// launch's liquidity WETH and refund penalties with the LP token share, adds late settlers'
/// liquidity at the pair's live ratio, and vests the creator allocation.
contract D17LiquidityVault {
    using D17SafeTransfer for address;

    bytes32 public constant D17_LIQUIDITY_VAULT_ID = keccak256("D17_LIQUIDITY_VAULT_V15_HARDENED");
    /// @notice The creator allocation unlocks linearly over this period, starting when the
    /// official pool is created (= when trading opens).
    uint256 public constant CREATOR_VESTING_SECONDS = 180 days;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    address public immutable launch;
    address public immutable token;
    address public immutable weth;
    address public immutable router;
    address public immutable routerFactory;
    address public immutable treasury;

    bool public poolCreated;
    address public officialPair;
    uint256 public poolCreatedAt;
    uint256 public tokenUsedForPool;
    uint256 public wethUsedForPool;
    uint256 public lpMinted;
    uint256 public lateTokenUsedForLp;
    uint256 public lateWethUsedForLp;
    uint256 public lateLpMinted;
    uint256 public lateTokensBurned;
    uint256 public lateWethBurned;
    uint256 public failedLaunchPenaltyWethBurned;
    uint256 public creatorTokensReleased;
    uint256 public preseededTokenReserve;
    uint256 public preseededWethReserve;
    uint256 private entered = 1;

    event OfficialPoolCreated(
        address indexed pair,
        uint256 tokenUsed,
        uint256 wethUsed,
        uint256 lpMinted,
        uint256 preseededTokenReserve,
        uint256 preseededWethReserve
    );
    event LateLiquidityAdded(
        address indexed locker,
        address indexed pair,
        uint256 tokenUsed,
        uint256 wethUsed,
        uint256 lpMinted,
        uint256 tokensBurned,
        uint256 wethBurned
    );
    event FailedLaunchPenaltiesBurned(uint256 amount);
    event CreatorTokensReleased(address indexed recipient, uint256 amount);
    event ExcessWethSwept(address indexed recipient, uint256 amount);
    event UnsupportedTokenRecovered(address indexed token, address indexed recipient, uint256 amount);
    event UnexpectedEthSwept(address indexed recipient, uint256 amount);

    modifier nonReentrant() {
        require(entered == 1, "REENTRANT");
        entered = 2;
        _;
        entered = 1;
    }

    constructor(address launch_, address token_, address weth_, address router_, address treasury_) {
        require(launch_ != address(0), "LAUNCH_ZERO");
        require(token_ != address(0), "TOKEN_ZERO");
        require(weth_ != address(0), "WETH_ZERO");
        require(router_ != address(0), "ROUTER_ZERO");
        require(treasury_ != address(0), "TREASURY_ZERO");
        require(launch_.code.length > 0, "LAUNCH_NO_CODE");
        require(token_.code.length > 0, "TOKEN_NO_CODE");
        require(weth_.code.length > 0, "WETH_NO_CODE");
        require(router_.code.length > 0, "ROUTER_NO_CODE");

        address routerFactory_ = IV2Router(router_).factory();
        require(routerFactory_ != address(0), "ROUTER_FACTORY_ZERO");
        require(routerFactory_.code.length > 0, "ROUTER_FACTORY_NO_CODE");

        launch = launch_;
        token = token_;
        weth = weth_;
        router = router_;
        routerFactory = routerFactory_;
        treasury = treasury_;
    }

    receive() external payable {
        revert("DIRECT_ETH_REJECTED");
    }

    fallback() external payable {
        revert("UNSUPPORTED_CALL");
    }

    /// @notice Creator tokens still held for vesting (never usable for liquidity).
    function lockedCreatorTokens() public view returns (uint256) {
        return ID17Launch(launch).manualDistributionTokens() - creatorTokensReleased;
    }

    function vestedCreatorTokens() public view returns (uint256) {
        if (!poolCreated) return 0;
        uint256 total = ID17Launch(launch).manualDistributionTokens();
        uint256 elapsed = block.timestamp - poolCreatedAt;
        if (elapsed >= CREATOR_VESTING_SECONDS) return total;
        return total * elapsed / CREATOR_VESTING_SECONDS;
    }

    function createOfficialPool(uint256 minLpMinted, uint256 deadline)
        external
        nonReentrant
        returns (address pair, uint256 liquidityTokens, uint256 wethForPool, uint256 liquidity)
    {
        require(!poolCreated, "POOL_CREATED");
        require(block.timestamp <= deadline, "DEADLINE");
        require(block.timestamp >= ID17Launch(launch).poolCreationOpensAt(), "POOL_CREATION_NOT_OPEN");

        pair = IV2Factory(routerFactory).getPair(token, weth);
        if (pair == address(0)) {
            pair = IV2Factory(routerFactory).createPair(token, weth);
        }
        require(pair.code.length > 0, "PAIR_NO_CODE");
        require(IV2PairView(pair).totalSupply() == 0, "PAIR_ALREADY_LIVE");

        // Pre-open token transfers are gated, so the pair cannot hold launch tokens. Anyone
        // may donate WETH to it; that donation can only raise the opening price and is lost
        // by the donor to the permanently locked pool.
        (uint256 tokenReserve, uint256 wethReserve) = _pairReserves(pair);
        uint256 tokenBalanceBefore = IERC20BalanceView(token).balanceOf(pair);
        uint256 wethBalanceBefore = IERC20BalanceView(weth).balanceOf(pair);
        uint256 preseededWeth = wethBalanceBefore > wethReserve ? wethBalanceBefore : wethReserve;
        require(tokenBalanceBefore == 0, "PAIR_PRESEEDED_TOKEN");

        (liquidityTokens, wethForPool) = ID17Launch(launch).claimVaultLiquidityTokens();
        require(
            IERC20BalanceView(token).balanceOf(address(this)) >= liquidityTokens + lockedCreatorTokens(),
            "VAULT_TOKEN_BALANCE"
        );
        require(liquidityTokens > 0, "NO_TOKEN_BALANCE");
        require(wethForPool > 0, "NO_WETH_FOR_POOL");
        require(IERC20BalanceView(weth).balanceOf(address(this)) >= wethForPool, "VAULT_WETH_BALANCE");

        token.safeTransfer(pair, liquidityTokens);
        weth.safeTransfer(pair, wethForPool);
        liquidity = IV2PairView(pair).mint(address(this));
        require(liquidity >= minLpMinted, "LP_SLIPPAGE");

        poolCreated = true;
        officialPair = pair;
        poolCreatedAt = block.timestamp;
        tokenUsedForPool = liquidityTokens;
        wethUsedForPool = wethForPool;
        lpMinted = liquidity;
        preseededTokenReserve = tokenReserve;
        preseededWethReserve = preseededWeth;

        ID17Launch(launch).markLiquidityPoolCreated(pair, liquidityTokens, wethForPool, liquidity);
        emit OfficialPoolCreated(pair, liquidityTokens, wethForPool, liquidity, tokenBalanceBefore, preseededWethReserve);
    }

    /// @notice Adds a late settler's LP-share WETH plus its reserved LP-token share to the
    /// official pair, minting LP to this vault (permanently locked). Called by the settling
    /// locker in the same transaction as claimLateSettlement().
    ///
    /// The deposit is balanced at the pair's live reserve ratio, so it never donates a
    /// one-sided surplus that a sandwich could capture. Whatever cannot be paired at that
    /// ratio (tokens if the price rose since launch, WETH if it fell) is burned: no one,
    /// including the late settler, gains from settling late or from moving the price.
    function mintLateLiquidity(uint256 tokenAmount, uint256 wethAmount)
        external
        nonReentrant
        returns (uint256 liquidity)
    {
        require(poolCreated, "POOL_NOT_CREATED");
        require(
            ID17FactoryView(ID17Launch(launch).factory()).isLocker(msg.sender),
            "NOT_D17_LOCKER"
        );
        require(
            IERC20BalanceView(token).balanceOf(address(this)) >= tokenAmount + lockedCreatorTokens(),
            "VAULT_TOKEN_BALANCE"
        );
        require(IERC20BalanceView(weth).balanceOf(address(this)) >= wethAmount, "VAULT_WETH_BALANCE");

        address pair = officialPair;
        (uint256 tokenReserve, uint256 wethReserve) = _pairReserves(pair);
        uint256 tokenUsed;
        uint256 wethUsed;
        if (tokenAmount > 0 && wethAmount > 0 && tokenReserve > 0 && wethReserve > 0) {
            wethUsed = tokenAmount * wethReserve / tokenReserve;
            if (wethUsed <= wethAmount) {
                tokenUsed = tokenAmount;
            } else {
                wethUsed = wethAmount;
                tokenUsed = wethAmount * tokenReserve / wethReserve;
            }
            uint256 supply = IV2PairView(pair).totalSupply();
            uint256 tokenLp = tokenUsed * supply / tokenReserve;
            uint256 wethLp = wethUsed * supply / wethReserve;
            // Too small to mint even one LP wei: burn instead of reverting, so a dust-sized
            // late position can always settle.
            if ((tokenLp < wethLp ? tokenLp : wethLp) == 0) {
                tokenUsed = 0;
                wethUsed = 0;
            }
        }

        if (tokenUsed > 0) {
            token.safeTransfer(pair, tokenUsed);
            weth.safeTransfer(pair, wethUsed);
            liquidity = IV2PairView(pair).mint(address(this));
            lateTokenUsedForLp += tokenUsed;
            lateWethUsedForLp += wethUsed;
            lateLpMinted += liquidity;
        }

        uint256 tokensBurned = tokenAmount - tokenUsed;
        uint256 wethBurned = wethAmount - wethUsed;
        if (tokensBurned > 0) {
            token.safeBurn(tokensBurned);
            lateTokensBurned += tokensBurned;
        }
        if (wethBurned > 0) {
            weth.safeTransfer(BURN_ADDRESS, wethBurned);
            lateWethBurned += wethBurned;
        }

        emit LateLiquidityAdded(msg.sender, pair, tokenUsed, wethUsed, liquidity, tokensBurned, wethBurned);
    }

    /// @notice Releases the vested part of the creator allocation to the creator wallet.
    /// Callable by anyone; the recipient is fixed in the launch's rules.
    function releaseCreatorTokens() external nonReentrant returns (uint256 amount) {
        amount = vestedCreatorTokens() - creatorTokensReleased;
        require(amount > 0, "NOTHING_VESTED");
        creatorTokensReleased += amount;
        address recipient = ID17Launch(launch).manualDistributionRecipient();
        token.safeTransfer(recipient, amount);
        emit CreatorTokensReleased(recipient, amount);
    }

    /// @notice Refund penalties paid during a launch that then failed have no pool to go
    /// to. They are burned rather than handed to the creator, the protocol or the refunder.
    function burnFailedLaunchPenalties() external nonReentrant returns (uint256 amount) {
        require(ID17Launch(launch).launchFailed(), "LAUNCH_NOT_FAILED");
        amount = IERC20BalanceView(weth).balanceOf(address(this));
        require(amount > 0, "NO_WETH");
        failedLaunchPenaltyWethBurned += amount;
        weth.safeTransfer(BURN_ADDRESS, amount);
        emit FailedLaunchPenaltiesBurned(amount);
    }

    /// @notice After pool creation every legitimate WETH flow through the vault is atomic,
    /// so any balance here is an unsolicited donation.
    function sweepExcessWethToTreasury() external nonReentrant returns (uint256 amount) {
        require(poolCreated, "POOL_NOT_CREATED");
        amount = IERC20BalanceView(weth).balanceOf(address(this));
        require(amount > 0, "NO_EXCESS_WETH");
        weth.safeTransfer(treasury, amount);
        emit ExcessWethSwept(treasury, amount);
    }

    function recoverUnsupportedTokenToTreasury(address tokenAddress, uint256 amount) external nonReentrant {
        require(amount > 0, "AMOUNT_ZERO");
        require(tokenAddress != address(0), "TOKEN_ZERO");
        require(tokenAddress != token, "D17_TOKEN_PROTECTED");
        require(tokenAddress != weth, "WETH_PROTECTED");
        require(tokenAddress != officialPair, "LP_PROTECTED");
        tokenAddress.safeTransfer(treasury, amount);
        emit UnsupportedTokenRecovered(tokenAddress, treasury, amount);
    }

    /// @notice Forced ETH is wrapped and sent as WETH so the sweep can never be blocked.
    function sweepUnexpectedEthToTreasury() external nonReentrant returns (uint256 amount) {
        amount = address(this).balance;
        require(amount > 0, "NO_ETH_BALANCE");
        IWETH(weth).deposit{value: amount}();
        weth.safeTransfer(treasury, amount);
        emit UnexpectedEthSwept(treasury, amount);
    }

    function _pairReserves(address pair) internal view returns (uint256 tokenReserve, uint256 wethReserve) {
        (uint112 reserve0, uint112 reserve1, ) = IV2PairView(pair).getReserves();
        address token0 = IV2PairView(pair).token0();
        if (token0 == token) {
            tokenReserve = uint256(reserve0);
            wethReserve = uint256(reserve1);
        } else {
            tokenReserve = uint256(reserve1);
            wethReserve = uint256(reserve0);
        }
    }
}
