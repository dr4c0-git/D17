// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {D17Launch} from "./D17Launch.sol";

/// @notice Deploys D17Launch instances for the pinned D17LaunchFactory. Split out of the
/// launch factory so that the launch's creation code no longer counts against the
/// launch factory's EIP-170 runtime size limit. Same owner-pin-renounce lifecycle as
/// D17TokenFactory and D17LiquidityVaultFactory.
contract D17LaunchDeployer {
    bytes32 public constant D17_LAUNCH_DEPLOYER_ID = keccak256("D17_LAUNCH_DEPLOYER_V15_HARDENED");

    address public owner;
    address public launchFactory;
    bool public launchFactoryPinned;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event LaunchFactoryPinned(address indexed launchFactory);
    event LaunchDeployed(address indexed launch);

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

    /// @param encodedParams abi.encode(D17Launch.LaunchParams). Passed pre-encoded so this
    /// contract stays a thin wrapper around the launch creation code.
    /// @dev The calling launch factory must be the launch's one-shot vault configurator
    /// (second static word of the encoded params).
    function deployLaunch(bytes calldata encodedParams) external returns (address launch) {
        require(launchFactoryPinned && msg.sender == launchFactory, "NOT_LAUNCH_FACTORY");
        require(abi.decode(encodedParams[32:64], (address)) == msg.sender, "VAULT_CONFIGURATOR");
        bytes memory initCode = abi.encodePacked(type(D17Launch).creationCode, encodedParams);
        assembly ("memory-safe") {
            launch := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(launch != address(0), "LAUNCH_DEPLOY_FAILED");
        emit LaunchDeployed(launch);
    }
}
