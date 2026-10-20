// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {D17SafeTransfer} from "./lib/D17SafeTransfer.sol";
import {IWETH} from "./interfaces/ID17.sol";

/// @notice Splits the protocol fee between fixed recipients, in fixed shares.
///
/// Meant to be the `feeRecipient` of D17FeeConfig: launches pay their protocol fee here in
/// WETH, and anyone can call `distribute` to forward the balance to the recipients.
///
/// There is no owner and no setter: the recipients and their shares are set once in the
/// constructor and can never change. Nothing can be withdrawn except through `distribute`,
/// which always pays every recipient its share. Plain ETH sent here is wrapped into WETH by
/// `distributeEth` and split the same way.
contract D17FeeSplitter {
    using D17SafeTransfer for address;

    bytes32 public constant D17_FEE_SPLITTER_ID = keccak256("D17_FEE_SPLITTER_V1");
    uint16 public constant BPS = 10_000;
    uint256 public constant MAX_RECIPIENTS = 5;

    address public immutable weth;
    address[] private _recipients;
    uint16[] private _sharesBps;
    bool private _locked;

    event Distributed(address indexed token, address indexed recipient, uint256 amount);

    modifier nonReentrant() {
        require(!_locked, "REENTRANT");
        _locked = true;
        _;
        _locked = false;
    }

    constructor(address weth_, address[] memory recipients_, uint16[] memory sharesBps_) {
        require(weth_ != address(0), "WETH_ZERO");
        require(recipients_.length > 0 && recipients_.length <= MAX_RECIPIENTS, "RECIPIENT_COUNT");
        require(recipients_.length == sharesBps_.length, "LENGTH_MISMATCH");
        uint256 total;
        for (uint256 i; i < recipients_.length; i++) {
            require(recipients_[i] != address(0), "RECIPIENT_ZERO");
            require(sharesBps_[i] > 0, "SHARE_ZERO");
            for (uint256 j; j < i; j++) require(recipients_[j] != recipients_[i], "RECIPIENT_DUPLICATE");
            total += sharesBps_[i];
        }
        require(total == BPS, "SHARES_NOT_100_PERCENT");
        weth = weth_;
        _recipients = recipients_;
        _sharesBps = sharesBps_;
    }

    receive() external payable {}

    function recipients() external view returns (address[] memory recipients_, uint16[] memory sharesBps_) {
        return (_recipients, _sharesBps);
    }

    /// @notice Forwards this contract's whole balance of `token` to the recipients. Anyone can
    /// call it. The last recipient receives the rounding remainder, so nothing is left behind.
    function distribute(address token) public nonReentrant returns (uint256 total) {
        total = _balanceOf(token);
        if (total == 0) return 0;
        uint256 paid;
        uint256 last = _recipients.length - 1;
        for (uint256 i; i <= last; i++) {
            uint256 amount = i == last ? total - paid : (total * _sharesBps[i]) / BPS;
            paid += amount;
            if (amount > 0) {
                token.safeTransfer(_recipients[i], amount);
                emit Distributed(token, _recipients[i], amount);
            }
        }
    }

    /// @notice Wraps any plain ETH held here into WETH, then distributes the WETH balance.
    function distributeEth() external returns (uint256 total) {
        uint256 ethBalance = address(this).balance;
        if (ethBalance > 0) IWETH(weth).deposit{value: ethBalance}();
        return distribute(weth);
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        require(ok && data.length >= 32, "BALANCE_READ");
        return abi.decode(data, (uint256));
    }
}
