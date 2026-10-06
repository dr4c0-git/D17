// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only: force-sends ETH to a contract that rejects plain transfers.
contract TestForceEth {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}
