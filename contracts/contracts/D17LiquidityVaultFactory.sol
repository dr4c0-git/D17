// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {D17LiquidityVault} from "./D17LiquidityVault.sol";

contract D17LiquidityVaultFactory {
    bytes32 public constant D17_LIQUIDITY_VAULT_FACTORY_ID = keccak256("D17_LIQUIDITY_VAULT_FACTORY_V15_HARDENED");

    address public owner;
    address public launchFactory;
    bool public launchFactoryPinned;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event LaunchFactoryPinned(address indexed launchFactory);
    event LiquidityVaultCreated(address indexed launch, address indexed token, address indexed liquidityVault);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(address owner_) {
        require(owner_ != address(0), "OWNER_ZERO");
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function pinLaunchFactory(address launchFactory_) external onlyOwner {
        require(!launchFactoryPinned, "LAUNCH_FACTORY_PINNED");
        require(launchFactory_ != address(0), "LAUNCH_FACTORY_ZERO");
        require(launchFactory_.code.length > 0, "LAUNCH_FACTORY_NO_CODE");
        launchFactory = launchFactory_;
        launchFactoryPinned = true;
        emit LaunchFactoryPinned(launchFactory_);
    }

    function renounceOwnership() external onlyOwner {
        require(launchFactoryPinned, "LAUNCH_FACTORY_UNLOCKED");
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }

    function deployVault(address launch, address token, address weth, address router, address treasury)
        external
        returns (address liquidityVault)
    {
        require(launchFactoryPinned && msg.sender == launchFactory, "NOT_LAUNCH_FACTORY");
        liquidityVault = address(new D17LiquidityVault(launch, token, weth, router, treasury));
        emit LiquidityVaultCreated(launch, token, liquidityVault);
    }
}
