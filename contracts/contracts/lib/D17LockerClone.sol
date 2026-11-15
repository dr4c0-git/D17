// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A Locker is a 105-byte contract: the standard EIP-1167 forwarding stub (45 bytes)
/// followed by its owner, the D17 factory and WETH (20 bytes each). The stub runs the shared
/// D17Locker code against the Locker's own storage. The three addresses are part of the
/// Locker's code, so they are fixed at creation like immutables: there is no initializer to
/// call, nothing to front-run and nothing that can be changed later.
library D17LockerClone {
    uint256 private constant STUB_BYTES = 45;
    uint256 internal constant OWNER = 0;
    uint256 internal constant FACTORY = 20;
    uint256 internal constant WETH = 40;

    function deploy(address implementation, address owner, address factory, address weth)
        internal
        returns (address locker)
    {
        bytes memory creationCode = abi.encodePacked(
            // Creation: return the 105 bytes that follow.
            hex"61", uint16(STUB_BYTES + 60), hex"3d81600a3d39f3",
            // EIP-1167: delegatecall `implementation`, return or revert with its data.
            hex"363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3",
            owner, factory, weth
        );
        assembly ("memory-safe") {
            locker := create(0, add(creationCode, 0x20), mload(creationCode))
        }
        require(locker != address(0), "LOCKER_CREATE_FAILED");
    }

    /// @dev Reads one address from the code of the Locker being run. Under delegatecall
    /// `address()` is the Locker, so the value comes from its own code, never from calldata.
    function arg(uint256 position) internal view returns (address value) {
        assembly ("memory-safe") {
            mstore(0x00, 0)
            extcodecopy(address(), 0x0c, add(STUB_BYTES, position), 0x14)
            value := mload(0x00)
        }
    }
}
