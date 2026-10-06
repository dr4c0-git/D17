// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ID17LaunchFactory {
    struct Link {
        string linkType;
        string url;
    }

    struct LaunchConfig {
        string tokenName;
        string tokenSymbol;
        string description;
        string logoSvgUri;
        Link[] links;
        uint256 tokenSupply;
        uint256 saleTokens;
        uint256 lpTokens;
        uint256 manualDistributionTokens;
        uint256 deadTokens;
        address deadRecipient;
        address treasury;
        uint64 startTime;
        uint32[5] roundSeconds;
        uint32 refundSeconds;
        uint32 settlementSeconds;
        uint256 minCommitWeth;
        uint256 minPhase1Weth;
        uint256 minAnchorPriceWad;
        uint16[5] roundSharesBps;
        uint16 treasuryBps;
        uint16 refundPenaltyBps;
        // Creator's consent bound on the protocol fee: creation reverts if the fee read
        // from D17FeeConfig at execution time is above this value.
        uint16 maxProtocolFeeBps;
    }

    function deployLaunch(
        LaunchConfig calldata config,
        address creator,
        address protocolFeeRecipient,
        uint16 protocolFeeBps
    )
        external
        returns (address token, address launch, address liquidityVault);
}
