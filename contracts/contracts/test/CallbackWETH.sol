// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Hostile dependency fixture only. NEVER a deployable production WETH.
contract CallbackWETH {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    address public target;
    bytes public payload;
    uint256 public callbackValue;
    bool public onDeposit;
    bool public onTransfer;
    bool public rejectDeposit;
    bool private entered;
    bool public lastSuccess;
    bytes public lastResult;
    uint256 public attempts;
    event Transfer(address indexed from, address indexed to, uint256 amount);

    receive() external payable {}
    function setRejectDeposit(bool reject_) external { rejectDeposit = reject_; }
    function arm(address to, bytes calldata data, uint256 value, bool deposit_, bool transfer_) external {
        target = to; payload = data; callbackValue = value;
        onDeposit = deposit_; onTransfer = transfer_; lastSuccess = false; delete lastResult;
    }
    function execute(address to, bytes calldata data, uint256 value) external payable returns (bytes memory result) {
        bool ok;
        (ok, result) = to.call{value: value}(data);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
    }
    function deposit() external payable {
        require(!rejectDeposit, "DEPOSIT_REJECTED");
        balanceOf[msg.sender] += msg.value; totalSupply += msg.value;
        emit Transfer(address(0), msg.sender, msg.value);
        if (onDeposit) _callback();
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        if (onTransfer) _callback();
        return true;
    }
    function _callback() private {
        if (entered || target == address(0)) return;
        entered = true; attempts++;
        (lastSuccess, lastResult) = target.call{value: callbackValue}(payload);
        entered = false;
    }
}
