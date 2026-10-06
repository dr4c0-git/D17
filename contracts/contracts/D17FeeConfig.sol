// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Protocol fee settings for FUTURE launches only.
///
/// What the owner can do:
///   - set the fee recipient and the fee rate, never above MAX_PROTOCOL_FEE_BPS (2%);
///   - hand over or renounce ownership (renouncing freezes the current settings forever).
/// What the owner can NOT do:
///   - touch any existing launch: D17Factory copies (recipient, rate) into each launch's
///     immutables at creation and they are part of that launch's rulesHash;
///   - move, pause or redirect any participant's funds: this contract holds nothing and
///     is only read by D17Factory.createLaunch.
/// The fee is charged only on successful settlement (a share of each settled commitment).
/// Refunds, refund penalties and failed launches never pay it.
contract D17FeeConfig {
    bytes32 public constant D17_FEE_CONFIG_ID = keccak256("D17_FEE_CONFIG_V15_HARDENED");
    uint16 public constant MAX_PROTOCOL_FEE_BPS = 200;

    address public owner;
    address public pendingOwner;
    address public feeRecipient;
    uint16 public protocolFeeBps;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProtocolFeeUpdated(address indexed feeRecipient, uint16 protocolFeeBps);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(address owner_, address feeRecipient_, uint16 protocolFeeBps_) {
        require(owner_ != address(0), "OWNER_ZERO");
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        _setFee(feeRecipient_, protocolFeeBps_);
    }

    function setProtocolFee(address feeRecipient_, uint16 protocolFeeBps_) external onlyOwner {
        _setFee(feeRecipient_, protocolFeeBps_);
    }

    function currentFee() external view returns (address recipient, uint16 bps) {
        return (feeRecipient, protocolFeeBps);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner && msg.sender != address(0), "NOT_PENDING_OWNER");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
        pendingOwner = address(0);
    }

    function _setFee(address feeRecipient_, uint16 protocolFeeBps_) private {
        require(protocolFeeBps_ <= MAX_PROTOCOL_FEE_BPS, "FEE_ABOVE_CAP");
        require(protocolFeeBps_ == 0 || feeRecipient_ != address(0), "FEE_RECIPIENT_ZERO");
        feeRecipient = feeRecipient_;
        protocolFeeBps = protocolFeeBps_;
        emit ProtocolFeeUpdated(feeRecipient_, protocolFeeBps_);
    }
}
