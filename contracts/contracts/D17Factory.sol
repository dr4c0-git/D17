// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ID17Launch} from "./interfaces/ID17.sol";
import {ID17LaunchFactory} from "./interfaces/ID17LaunchFactory.sol";

interface IV2RouterView {
    function factory() external view returns (address);
}

interface ID17FeeConfigView {
    function currentFee() external view returns (address recipient, uint16 bps);
}

contract D17Factory {
    bytes32 public constant D17_FACTORY_ID = keccak256("D17_FACTORY_V15_HARDENED");
    uint16 public constant BPS = 10_000;
    // Creator treasury fee cap (V14: 20%). Every successful commitment keeps at least
    // BPS - MAX_TREASURY_BPS - D17FeeConfig.MAX_PROTOCOL_FEE_BPS = 88% for the locked pool.
    uint16 public constant MAX_TREASURY_BPS = 1_000;
    uint16 public constant MAX_MANUAL_DISTRIBUTION_BPS = 1_000;
    // Refund penalties go to the official pool, never to the creator; rounds 3-4 penalty
    // sits between the fixed early penalty (1%) and 25% (V14: 0-50%).
    uint16 public constant MIN_REFUND_PENALTY_BPS = 100;
    uint16 public constant MAX_REFUND_PENALTY_BPS = 2_500;
    uint8 public constant ROUND_COUNT = 5;
    uint256 public constant MAX_DESCRIPTION_BYTES = 512;
    uint256 public constant MAX_LINKS = 8;
    uint256 public constant MAX_LINK_TYPE_BYTES = 32;
    uint256 public constant MAX_LINK_URL_BYTES = 128;
    uint256 public constant MAX_LOGO_SVG_URI_BYTES = 8_192;
    string public constant LOGO_SVG_BASE64_PREFIX = "data:image/svg+xml;base64,";
    uint256 public constant MIN_COMMIT_WETH = 1e15;
    uint256 public constant MIN_LP_TOKENS = 1e18;
    uint256 public constant MIN_ROUND_ALLOCATION_TOKENS = 1e18;
    uint256 public constant MIN_ANCHOR_PRICE_WAD = 1e6;
    uint32 public constant MIN_ROUND_SECONDS = 60;
    uint32 public constant MAX_ROUND_SECONDS = 90 days;
    uint32 public constant MAX_REFUND_SECONDS = 30 days;
    uint32 public constant MAX_SETTLEMENT_SECONDS = 30 days;
    uint64 public constant MAX_START_DELAY = 365 days;
    // Ethereum mainnet floors: a launch must be announced on-chain at least a day before it
    // starts and every window must stay open long enough for ordinary wallets to act, so no
    // launch can be run as a stealth/bot-only event. Test networks keep short windows.
    uint32 public constant MAINNET_MIN_WINDOW_SECONDS = 1 hours;
    uint64 public constant MAINNET_MIN_START_DELAY = 1 days;

    address public owner;
    address public immutable weth;
    address public immutable router;
    address public immutable feeConfig;
    address public launchFactory;
    address public lockerFactory;
    bool public launchFactoryPinned;
    bool public lockerFactoryPinned;

    struct LaunchRecord {
        bool canonical;
        address creator;
        address token;
        address liquidityVault;
        bytes32 rulesHash;
    }

    mapping(address => LaunchRecord) public launches;
    mapping(address => bool) public isLocker;
    mapping(address => address[]) private lockersByOwner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event LaunchCreated(
        address indexed creator,
        address indexed launch,
        address indexed token,
        address liquidityVault,
        bytes32 rulesHash
    );
    event LaunchMetadataPublished(
        address indexed launch,
        bytes32 indexed metadataHash,
        string description,
        string logoSvgUri,
        string[] linkTypes,
        string[] linkUrls
    );
    event ManualDistributionConfigured(address indexed launch, address indexed recipient, uint256 amount);
    event LockerRegistered(address indexed owner, address indexed locker, address indexed manager);
    event LaunchFactoryPinned(address indexed launchFactory);
    event LockerFactoryPinned(address indexed lockerFactory);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(address owner_, address weth_, address router_, address feeConfig_) {
        require(owner_ != address(0), "OWNER_ZERO");
        require(weth_ != address(0), "WETH_ZERO");
        require(router_ != address(0), "ROUTER_ZERO");
        require(weth_.code.length > 0, "WETH_NO_CODE");
        require(router_.code.length > 0, "ROUTER_NO_CODE");
        require(IV2RouterView(router_).factory() != address(0), "ROUTER_FACTORY_ZERO");
        require(feeConfig_.code.length > 0, "FEE_CONFIG_NO_CODE");
        owner = owner_;
        weth = weth_;
        router = router_;
        feeConfig = feeConfig_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function registerLockerFor(address lockerOwner, address locker) external {
        require(lockerFactoryPinned && msg.sender == lockerFactory, "NOT_LOCKER_FACTORY");
        require(lockerOwner != address(0), "LOCKER_OWNER_ZERO");
        require(locker != address(0), "LOCKER_ZERO");
        require(locker.code.length > 0, "LOCKER_NO_CODE");
        require(!isLocker[locker], "LOCKER_REGISTERED");
        isLocker[locker] = true;
        lockersByOwner[lockerOwner].push(locker);
        emit LockerRegistered(lockerOwner, locker, msg.sender);
    }

    function pinLockerFactory(address lockerFactory_) external onlyOwner {
        require(!lockerFactoryPinned, "LOCKER_FACTORY_PINNED");
        require(lockerFactory_ != address(0), "LOCKER_FACTORY_ZERO");
        require(lockerFactory_.code.length > 0, "LOCKER_FACTORY_NO_CODE");
        lockerFactory = lockerFactory_;
        lockerFactoryPinned = true;
        emit LockerFactoryPinned(lockerFactory_);
    }

    function pinLaunchFactory(address launchFactory_) external onlyOwner {
        require(!launchFactoryPinned, "LAUNCH_FACTORY_PINNED");
        require(launchFactory_ != address(0), "LAUNCH_FACTORY_ZERO");
        require(launchFactory_.code.length > 0, "LAUNCH_FACTORY_NO_CODE");
        launchFactory = launchFactory_;
        launchFactoryPinned = true;
        emit LaunchFactoryPinned(launchFactory_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "OWNER_ZERO");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function renounceOwnership() external onlyOwner {
        require(launchFactoryPinned, "LAUNCH_FACTORY_UNLOCKED");
        require(lockerFactoryPinned, "LOCKER_FACTORY_UNLOCKED");
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }

    function lockersOfOwner(address lockerOwner) external view returns (address[] memory) {
        return lockersByOwner[lockerOwner];
    }

    function createLaunch(ID17LaunchFactory.LaunchConfig calldata config)
        external
        returns (address token, address launch, address liquidityVault)
    {
        require(launchFactoryPinned, "LAUNCH_FACTORY_UNLOCKED");
        require(lockerFactoryPinned, "LOCKER_FACTORY_UNLOCKED");
        // No launch can exist while a factory admin key does.
        require(owner == address(0), "FACTORY_NOT_RENOUNCED");
        _validateConfig(config);

        (address feeRecipient, uint16 feeBps) = ID17FeeConfigView(feeConfig).currentFee();
        require(feeBps <= config.maxProtocolFeeBps, "PROTOCOL_FEE_ABOVE_MAX");
        (token, launch, liquidityVault) =
            ID17LaunchFactory(launchFactory).deployLaunch(config, msg.sender, feeRecipient, feeBps);
        bytes32 rules = ID17Launch(launch).rulesHash();
        launches[launch] = LaunchRecord({
            canonical: true,
            creator: msg.sender,
            token: token,
            liquidityVault: liquidityVault,
            rulesHash: rules
        });

        (string[] memory linkTypes, string[] memory linkUrls) = _metadataLinkArrays(config.links);

        emit LaunchCreated(msg.sender, launch, token, liquidityVault, rules);
        emit ManualDistributionConfigured(launch, msg.sender, config.manualDistributionTokens);
        emit LaunchMetadataPublished(
            launch,
            ID17Launch(launch).metadataHash(),
            config.description,
            config.logoSvgUri,
            linkTypes,
            linkUrls
        );
    }

    function isCanonicalLaunch(address launch, bytes32 rulesHash) external view returns (bool) {
        LaunchRecord storage record = launches[launch];
        return record.canonical && record.rulesHash == rulesHash;
    }

    function _validateConfig(ID17LaunchFactory.LaunchConfig calldata config) internal view {
        require(bytes(config.tokenName).length > 0 && bytes(config.tokenName).length <= 64, "TOKEN_NAME");
        require(bytes(config.tokenSymbol).length > 0 && bytes(config.tokenSymbol).length <= 16, "TOKEN_SYMBOL");
        _validateJsonSafe(config.tokenName, "TOKEN_NAME_JSON");
        _validateJsonSafe(config.tokenSymbol, "TOKEN_SYMBOL_JSON");
        _validateMetadata(config);
        require(config.tokenSupply > 0, "SUPPLY_ZERO");
        require(config.saleTokens > 0, "SALE_ZERO");
        require(config.lpTokens >= MIN_LP_TOKENS, "LP_TOO_LOW");
        require(
            config.saleTokens + config.lpTokens + config.manualDistributionTokens + config.deadTokens
                == config.tokenSupply,
            "SUPPLY_SPLIT"
        );
        require(
            config.manualDistributionTokens * BPS <= config.tokenSupply * MAX_MANUAL_DISTRIBUTION_BPS,
            "MANUAL_ABOVE_CAP"
        );
        if (config.deadTokens > 0) {
            require(config.deadRecipient == 0x000000000000000000000000000000000000dEaD, "DEAD_RECIPIENT");
        }
        require(config.treasury != address(0), "TREASURY_ZERO");
        bool mainnet = block.chainid == 1;
        uint32 minWindow = mainnet ? MAINNET_MIN_WINDOW_SECONDS : 1;
        uint32 minRound = mainnet ? MAINNET_MIN_WINDOW_SECONDS : MIN_ROUND_SECONDS;
        require(config.startTime >= block.timestamp + (mainnet ? MAINNET_MIN_START_DELAY : 0), "START_TOO_SOON");
        require(config.startTime <= block.timestamp + MAX_START_DELAY, "START_TOO_FAR");
        require(config.refundSeconds >= minWindow && config.refundSeconds <= MAX_REFUND_SECONDS, "REFUND_SECONDS");
        require(
            config.settlementSeconds >= minWindow && config.settlementSeconds <= MAX_SETTLEMENT_SECONDS,
            "SETTLEMENT_SECONDS"
        );
        require(config.minCommitWeth >= MIN_COMMIT_WETH, "MIN_COMMIT_TOO_LOW");
        require(config.minPhase1Weth >= config.minCommitWeth, "MIN_PHASE1_WETH");
        require(config.minAnchorPriceWad >= MIN_ANCHOR_PRICE_WAD, "MIN_ANCHOR_PRICE_TOO_LOW");
        require(config.treasuryBps <= MAX_TREASURY_BPS, "TREASURY_BPS");
        require(
            config.refundPenaltyBps >= MIN_REFUND_PENALTY_BPS && config.refundPenaltyBps <= MAX_REFUND_PENALTY_BPS,
            "REFUND_PENALTY_BPS"
        );

        uint256 shareTotal;
        for (uint256 i; i < ROUND_COUNT; i++) {
            require(config.roundSeconds[i] >= minRound && config.roundSeconds[i] <= MAX_ROUND_SECONDS, "ROUND_SECONDS");
            require(config.roundSharesBps[i] > 0, "ROUND_SHARE_ZERO");
            require(
                config.saleTokens * config.roundSharesBps[i] / BPS >= MIN_ROUND_ALLOCATION_TOKENS,
                "ROUND_ALLOCATION_TOO_LOW"
            );
            shareTotal += config.roundSharesBps[i];
        }

        require(shareTotal == BPS, "ROUND_SHARE_TOTAL");
    }

    function _validateMetadata(ID17LaunchFactory.LaunchConfig calldata config) internal pure {
        require(bytes(config.description).length <= MAX_DESCRIPTION_BYTES, "DESCRIPTION_BYTES");
        _validateJsonSafe(config.description, "DESCRIPTION_JSON");
        require(config.links.length <= MAX_LINKS, "LINKS");

        for (uint256 i; i < config.links.length; i++) {
            _validateLinkType(config.links[i].linkType);
            _validateLinkUrl(config.links[i].url);
        }

        bytes calldata logo = bytes(config.logoSvgUri);
        require(logo.length <= MAX_LOGO_SVG_URI_BYTES, "LOGO_BYTES");
        if (logo.length > 0) {
            bytes memory prefix = bytes(LOGO_SVG_BASE64_PREFIX);
            require(_startsWith(config.logoSvgUri, prefix), "LOGO_PREFIX");
            require(logo.length > prefix.length, "LOGO_EMPTY");
            for (uint256 i = prefix.length; i < logo.length; i++) {
                require(_isBase64Byte(logo[i]), "LOGO_BASE64");
            }
        }
    }

    function _validateLinkType(string calldata value) internal pure {
        bytes calldata data = bytes(value);
        require(data.length > 0 && data.length <= MAX_LINK_TYPE_BYTES, "LINK_TYPE");
        for (uint256 i; i < data.length; i++) {
            bytes1 char = data[i];
            bool ok = (char >= 0x61 && char <= 0x7a) || (char >= 0x30 && char <= 0x39) || char == 0x2d;
            require(ok, "LINK_TYPE_CHARS");
        }
    }

    function _validateLinkUrl(string calldata value) internal pure {
        bytes calldata data = bytes(value);
        require(data.length > 0 && data.length <= MAX_LINK_URL_BYTES, "LINK_URL");
        require(_startsWith(value, bytes("https://")), "LINK_URL_SCHEME");
        _validateJsonSafe(value, "LINK_URL_JSON");
    }

    function _validateJsonSafe(string calldata value, string memory reason) internal pure {
        bytes calldata data = bytes(value);
        for (uint256 i; i < data.length; i++) {
            bytes1 char = data[i];
            if (char == 0x22 || char == 0x5c || char < 0x20) revert(reason);
        }
    }

    function _startsWith(string calldata value, bytes memory prefix) internal pure returns (bool) {
        bytes calldata data = bytes(value);
        if (data.length < prefix.length) return false;
        for (uint256 i; i < prefix.length; i++) {
            if (data[i] != prefix[i]) return false;
        }
        return true;
    }

    function _isBase64Byte(bytes1 char) internal pure returns (bool) {
        return (char >= 0x41 && char <= 0x5a)
            || (char >= 0x61 && char <= 0x7a)
            || (char >= 0x30 && char <= 0x39)
            || char == 0x2b
            || char == 0x2f
            || char == 0x3d;
    }

    function _metadataLinkArrays(ID17LaunchFactory.Link[] calldata links)
        internal
        pure
        returns (string[] memory linkTypes, string[] memory linkUrls)
    {
        linkTypes = new string[](links.length);
        linkUrls = new string[](links.length);
        for (uint256 i; i < links.length; i++) {
            linkTypes[i] = links[i].linkType;
            linkUrls[i] = links[i].url;
        }
    }
}
