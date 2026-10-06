// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ID17LaunchFactory} from "./interfaces/ID17LaunchFactory.sol";

interface ID17TokenGateV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address);
}

interface ID17TokenGateLaunch {
    function tradingOpen() external view returns (bool);
}

contract D17Token {
    bytes32 public constant D17_TOKEN_ID = keccak256("D17_TOKEN_V15_HARDENED");

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public immutable maxSupply;
    uint256 public totalSupply;
    address public owner;
    address public launch;
    address public d17Factory;
    address public weth;
    address public routerFactory;
    address public liquidityVault;
    uint256 public tradingOpenAt;
    bool public mintingClosed;
    bool public tradingGateConfigured;
    bool public metadataConfigured;
    string public description;
    string public logoSvgUri;
    bytes32 public metadataHash;

    struct MetadataLink {
        string linkType;
        string url;
    }

    MetadataLink[] private metadataLinks;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event MintingClosed();
    event TradingGateConfigured(
        address indexed launch,
        address indexed d17Factory,
        address indexed weth,
        address routerFactory,
        address liquidityVault,
        uint256 tradingOpenAt
    );
    event TokenMetadataConfigured(
        bytes32 indexed metadataHash,
        string description,
        string logoSvgUri,
        string[] linkTypes,
        string[] linkUrls
    );
    event ContractURIUpdated();

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(address owner_, string memory name_, string memory symbol_, uint256 maxSupply_) {
        require(owner_ != address(0), "OWNER_ZERO");
        require(bytes(name_).length > 0 && bytes(name_).length <= 64, "NAME");
        require(bytes(symbol_).length > 0 && bytes(symbol_).length <= 16, "SYMBOL");
        _validateJsonSafe(name_, "NAME_JSON");
        _validateJsonSafe(symbol_, "SYMBOL_JSON");
        require(maxSupply_ > 0, "SUPPLY_ZERO");
        owner = owner_;
        name = name_;
        symbol = symbol_;
        maxSupply = maxSupply_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function configureTradingGate(
        address launch_,
        address d17Factory_,
        address weth_,
        address routerFactory_,
        address liquidityVault_,
        uint256 tradingOpenAt_
    ) external onlyOwner {
        require(!tradingGateConfigured, "TRADING_GATE_CONFIGURED");
        require(launch_ != address(0), "LAUNCH_ZERO");
        require(d17Factory_ != address(0), "FACTORY_ZERO");
        require(weth_ != address(0), "WETH_ZERO");
        require(routerFactory_ != address(0), "ROUTER_FACTORY_ZERO");
        require(liquidityVault_ != address(0), "VAULT_ZERO");
        require(launch_.code.length > 0, "LAUNCH_NO_CODE");
        require(d17Factory_.code.length > 0, "FACTORY_NO_CODE");
        require(weth_.code.length > 0, "WETH_NO_CODE");
        require(routerFactory_.code.length > 0, "ROUTER_FACTORY_NO_CODE");
        require(liquidityVault_.code.length > 0, "VAULT_NO_CODE");
        require(tradingOpenAt_ > block.timestamp, "TRADING_OPEN_NOW");

        launch = launch_;
        d17Factory = d17Factory_;
        weth = weth_;
        routerFactory = routerFactory_;
        liquidityVault = liquidityVault_;
        tradingOpenAt = tradingOpenAt_;
        tradingGateConfigured = true;

        emit TradingGateConfigured(launch_, d17Factory_, weth_, routerFactory_, liquidityVault_, tradingOpenAt_);
    }

    function configureMetadata(
        string calldata description_,
        string calldata logoSvgUri_,
        ID17LaunchFactory.Link[] calldata links_
    ) external onlyOwner {
        require(!metadataConfigured, "METADATA_CONFIGURED");
        description = description_;
        logoSvgUri = logoSvgUri_;
        for (uint256 i; i < links_.length; i++) {
            metadataLinks.push(MetadataLink({linkType: links_[i].linkType, url: links_[i].url}));
        }
        metadataHash = keccak256(abi.encode(name, symbol, description_, logoSvgUri_, links_));
        metadataConfigured = true;

        emit TokenMetadataConfigured(metadataHash, description_, logoSvgUri_, _metadataLinkTypes(), _metadataLinkUrls());
        emit ContractURIUpdated();
    }

    function tradingOpen() external view returns (bool) {
        return _launchTradingOpen();
    }

    function linkCount() external view returns (uint256) {
        return metadataLinks.length;
    }

    function links(uint256 index) external view returns (string memory linkType, string memory url) {
        require(index < metadataLinks.length, "LINK_INDEX");
        MetadataLink storage link = metadataLinks[index];
        return (link.linkType, link.url);
    }

    function contractURI() external view returns (string memory) {
        return string(abi.encodePacked("data:application/json;charset=utf-8,", _contractMetadataJson()));
    }

    function canonicalPair() public view returns (address) {
        if (!tradingGateConfigured) return address(0);
        return ID17TokenGateV2Factory(routerFactory).getPair(address(this), weth);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ALLOWANCE");
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function burn(uint256 amount) external {
        // Pre-open burns are restricted to the launch (unsold sale-token burn at
        // finalization). The launch factory mints the manual allocation before trading
        // opens; without this gate the creator could change the visible supply/tokenomics
        // before the launch outcome is known. After trading opens any holder may burn.
        require(msg.sender == launch || _launchTradingOpen(), "BURN_BEFORE_OPEN");
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        unchecked {
            balanceOf[msg.sender] -= amount;
            totalSupply -= amount;
        }
        emit Transfer(msg.sender, address(0), amount);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        require(!mintingClosed, "MINTING_CLOSED");
        require(totalSupply + amount <= maxSupply, "CAP");
        require(to != address(0), "TO_ZERO");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function closeMinting() external onlyOwner {
        require(!mintingClosed, "MINTING_CLOSED");
        mintingClosed = true;
        emit MintingClosed();
    }

    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "TO_ZERO");
        require(_transferAllowedBeforeOpen(from, to), "TRADING_CLOSED");
        require(balanceOf[from] >= amount, "BALANCE");
        if (amount == 0) {
            emit Transfer(from, to, 0);
            return;
        }
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    function _transferAllowedBeforeOpen(address from, address to) private view returns (bool) {
        if (!tradingGateConfigured) return false;
        if (from == launch) return true;

        address pair = canonicalPair();
        if (pair != address(0) && to == pair && from == liquidityVault) return true;

        if (_launchTradingOpen()) return true;

        return false;
    }

    function _launchTradingOpen() private view returns (bool) {
        if (!tradingGateConfigured) return false;
        try ID17TokenGateLaunch(launch).tradingOpen() returns (bool open) {
            return open;
        } catch {
            return false;
        }
    }

    function _contractMetadataJson() private view returns (bytes memory) {
        bytes memory json = abi.encodePacked(
            '{"name":"',
            name,
            '","symbol":"',
            symbol,
            '","description":"',
            description,
            '","image":"',
            logoSvgUri,
            '","links":['
        );

        for (uint256 i; i < metadataLinks.length; i++) {
            MetadataLink storage link = metadataLinks[i];
            if (i > 0) json = abi.encodePacked(json, ",");
            json = abi.encodePacked(json, '{"type":"', link.linkType, '","url":"', link.url, '"}');
        }

        return abi.encodePacked(json, "]}");
    }

    function _metadataLinkTypes() private view returns (string[] memory linkTypes) {
        linkTypes = new string[](metadataLinks.length);
        for (uint256 i; i < metadataLinks.length; i++) {
            linkTypes[i] = metadataLinks[i].linkType;
        }
    }

    function _metadataLinkUrls() private view returns (string[] memory linkUrls) {
        linkUrls = new string[](metadataLinks.length);
        for (uint256 i; i < metadataLinks.length; i++) {
            linkUrls[i] = metadataLinks[i].url;
        }
    }

    function _validateJsonSafe(string memory value, string memory reason) private pure {
        bytes memory data = bytes(value);
        for (uint256 i; i < data.length; i++) {
            bytes1 char = data[i];
            if (char == 0x22 || char == 0x5c || char < 0x20) revert(reason);
        }
    }
}
