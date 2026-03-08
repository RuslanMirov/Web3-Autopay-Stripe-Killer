// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockUSDC - ERC-20 stablecoin used for subscription payments
contract MockUSDC is ERC20, Ownable {
    uint8 private _decimals;

    constructor() ERC20("Mock USDC", "USDC") Ownable(msg.sender) {
        _decimals = 6;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mint tokens – callable by owner (test helper / Paymaster)
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
