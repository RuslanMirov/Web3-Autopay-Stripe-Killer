// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "./interfaces/IERC4337.sol";
import "./SubscriptionWallet.sol";

// ─── MockUSDC ────────────────────────────────────────────────────────────────

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) { return 6; }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// ─── MockEntryPoint ───────────────────────────────────────────────────────────
// Simulates the canonical EntryPoint's handleOps flow for testing.
// Calls validateUserOp → if passes → executes callData on the wallet.
// Also implements the minimal IEntryPoint interface so wallets can
// call depositTo / withdrawTo / balanceOf / getNonce.

contract MockEntryPoint is IEntryPoint {
    // ETH deposits per account (simulates EntryPoint's stake manager)
    mapping(address => uint256) private _deposits;
    // Nonces per sender
    mapping(address => uint256) private _nonces;

    // ── IEntryPoint implementation ────────────────────────────────────────────

    function handleOps(UserOperation[] calldata ops, address payable beneficiary)
        external override
    {
        for (uint256 i = 0; i < ops.length; i++) {
            _handleOp(ops[i]);
        }
        // Ignore beneficiary in test environment
        (beneficiary);
    }

    function getNonce(address sender, uint192 /*key*/)
        external view override returns (uint256)
    {
        return _nonces[sender];
    }

    function depositTo(address account) external payable override {
        _deposits[account] += msg.value;
    }

    function withdrawTo(address payable withdrawAddress, uint256 amount)
        external override
    {
        require(_deposits[msg.sender] >= amount, "EP: insufficient deposit");
        _deposits[msg.sender] -= amount;
        (bool ok,) = withdrawAddress.call{value: amount}("");
        require(ok, "EP: withdraw failed");
    }

    function balanceOf(address account) external view override returns (uint256) {
        return _deposits[account];
    }

    // ── Test helpers ─────────────────────────────────────────────────────────

    /// @notice Directly execute a single UserOp (like handleOps but returns
    ///         the raw validationData for assertion in tests).
    function simulateOp(UserOperation calldata userOp)
        external
        returns (uint256 validationData)
    {
        IAccount wallet = IAccount(userOp.sender);
        validationData = wallet.validateUserOp(userOp, keccak256(abi.encode(userOp)), 0);

        if (validationData == 0) {
            _executeCallData(userOp.sender, userOp.callData);
            _nonces[userOp.sender]++;
        }
    }

    /// @notice Just validate without executing (for validateUserOp unit tests).
    function validateOnly(UserOperation calldata userOp)
        external
        returns (uint256 validationData)
    {
        IAccount wallet = IAccount(userOp.sender);
        return wallet.validateUserOp(userOp, keccak256(abi.encode(userOp)), 0);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _handleOp(UserOperation calldata userOp) internal {
        IAccount wallet = IAccount(userOp.sender);
        uint256 result = wallet.validateUserOp(userOp, keccak256(abi.encode(userOp)), 0);
        require(result == 0, "EP: validation failed");
        _executeCallData(userOp.sender, userOp.callData);
        _nonces[userOp.sender]++;
    }

    function _executeCallData(address target, bytes calldata data) internal {
        (bool success, bytes memory ret) = target.call(data);
        if (!success) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }

    receive() external payable {}
}

// ─── MockService ─────────────────────────────────────────────────────────────
// Minimal service contract for tests. Just receives tokens.

contract MockService {
    address public immutable token;
    uint256 public totalReceived;

    event PaymentReceived(address indexed wallet, uint256 amount);

    constructor(address _token) {
        token = _token;
    }

    // Called by SubscriptionWallet.executeClaim — tokens arrive via safeTransfer
    // We track balance changes to verify correct amounts
    function getBalance() external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    receive() external payable {}
}
