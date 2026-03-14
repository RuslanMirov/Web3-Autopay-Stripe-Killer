// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ─── ERC-4337 v0.6 UserOperation ─────────────────────────────────────────────
// Matches the canonical EntryPoint at 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789

struct UserOperation {
    address   sender;               // The smart account (wallet) address
    uint256   nonce;                // Anti-replay nonce (managed by EntryPoint)
    bytes     initCode;             // Factory calldata for first-time deployment (empty if deployed)
    bytes     callData;             // Encoded function call to execute on the wallet
    uint256   callGasLimit;         // Gas limit for the execution phase
    uint256   verificationGasLimit; // Gas limit for validateUserOp
    uint256   preVerificationGas;   // Overhead gas charged by bundler
    uint256   maxFeePerGas;         // EIP-1559 max fee
    uint256   maxPriorityFeePerGas; // EIP-1559 priority fee
    bytes     paymasterAndData;     // Paymaster address + data (empty = self-pay)
    bytes     signature;            // Owner ECDSA sig OR empty bytes for subscription claims
}

/// @dev Validation result codes
uint256 constant SIG_VALIDATION_SUCCESS = 0;
uint256 constant SIG_VALIDATION_FAILED  = 1;

// ─── IAccount ────────────────────────────────────────────────────────────────

interface IAccount {
    /**
     * @notice Called by EntryPoint before execution.
     * @param userOp             The UserOperation being validated.
     * @param userOpHash         Hash of the UserOp (for ECDSA signature verification).
     * @param missingAccountFunds ETH the account must send to EntryPoint to cover gas.
     * @return validationData    0 = success, 1 = failure (or packed sig+time data).
     */
    function validateUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData);
}

// ─── IEntryPoint (minimal surface we need) ───────────────────────────────────

interface IEntryPoint {
    /// @notice Submit a batch of UserOperations.
    function handleOps(UserOperation[] calldata ops, address payable beneficiary) external;

    /// @notice Get the current nonce for a sender (sequential key=0).
    function getNonce(address sender, uint192 key) external view returns (uint256 nonce);

    /// @notice Deposit ETH into EntryPoint on behalf of an account (for gas).
    function depositTo(address account) external payable;

    /// @notice Withdraw deposited ETH back to the account.
    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external;

    /// @notice Get an account's deposit balance on the EntryPoint.
    function balanceOf(address account) external view returns (uint256);
}
