// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {D17Locker} from "./D17Locker.sol";

interface ID17LockerRegistry {
    function weth() external view returns (address);
    function isLocker(address locker) external view returns (bool);
    function registerLockerFor(address lockerOwner, address locker) external;
}

contract D17LockerFactory {
    address public immutable d17Factory;
    // One settlement used about 1M gas on Sepolia (0.5-0.7M on a local chain), so each locker
    // gets a wide margin. A full batch must also fit the 16,777,216 gas cap per transaction
    // (EIP-7825): 4 x (3,000,000 + 25,000) + 100,000 = 12.2M.
    uint256 public constant MAX_SETTLEMENT_BATCH = 4;
    uint256 public constant SETTLEMENT_CALL_GAS = 3_000_000;

    event LockerCreated(address indexed owner, address indexed locker);
    event BatchSettlementResult(address indexed launch, address indexed locker, bool success);

    constructor(address d17Factory_) {
        require(d17Factory_ != address(0), "FACTORY_ZERO");
        require(d17Factory_.code.length > 0, "FACTORY_NO_CODE");
        d17Factory = d17Factory_;
    }

    function createLockerFor(address lockerOwner) external returns (address locker) {
        require(lockerOwner != address(0), "OWNER_ZERO");
        require(msg.sender == lockerOwner, "ONLY_SELF");
        ID17LockerRegistry registry = ID17LockerRegistry(d17Factory);
        locker = address(new D17Locker(lockerOwner, d17Factory, registry.weth()));
        registry.registerLockerFor(lockerOwner, locker);
        emit LockerCreated(lockerOwner, locker);
    }

    /// @notice Optional permissionless cleanup after grace. Each canonical Locker retains
    /// its own checks and sends claims only to its owner-controlled escrow. Bad inputs,
    /// duplicates and already-settled positions do not block the rest of a bounded batch.
    /// Direct Locker.settleAfterGrace remains available if future gas costs exceed the cap.
    function settleAfterGraceBatch(address launch, address[] calldata lockers)
        external
        returns (uint256 completed)
    {
        uint256 count = lockers.length;
        require(count > 0 && count <= MAX_SETTLEMENT_BATCH, "BATCH_SIZE");
        // Reserve enough for every subcall plus EIP-150 forwarding and per-item overhead.
        require(gasleft() >= count * (SETTLEMENT_CALL_GAS + 25_000) + 100_000, "BATCH_GAS");
        for (uint256 i; i < count; i++) {
            address locker = lockers[i];
            bool success;
            if (ID17LockerRegistry(d17Factory).isLocker(locker)) {
                try D17Locker(payable(locker)).settleAfterGrace{gas: SETTLEMENT_CALL_GAS}(launch) returns (uint256) {
                    success = true;
                    completed++;
                } catch {}
            }
            emit BatchSettlementResult(launch, locker, success);
        }
    }
}
