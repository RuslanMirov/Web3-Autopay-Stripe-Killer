// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IERC4337.sol";
import "./SubscriptionWallet.sol";

/// @title  ClaimBundlerHelper
/// @notice Off-chain helper — deployed as a view-only contract that bundlers
///         call to build valid subscription claim UserOperations.
///
///         This is NOT the EntryPoint. Bundlers call simulateClaimOp() off-chain
///         (via eth_call) to build the UserOp, then submit to EntryPoint.handleOps().
///
///         Claim UserOp anatomy:
///           sender:    wallet address
///           nonce:     entryPoint.getNonce(wallet, 0)
///           initCode:  0x (wallet already deployed)
///           callData:  abi.encodeCall(wallet.executeClaim, (service))
///           signature: abi.encodePacked(CLAIM_MAGIC, abi.encode(service))
///           paymasterAndData: 0x (wallet funds its own gas via EntryPoint deposit)
///
contract ClaimBundlerHelper {

    IEntryPoint public immutable entryPoint;

    // Gas limits tuned for typical claim operations
    uint256 public constant DEFAULT_CALL_GAS_LIMIT         = 100_000;
    uint256 public constant DEFAULT_VERIFICATION_GAS_LIMIT = 150_000;
    uint256 public constant DEFAULT_PRE_VERIFICATION_GAS   = 50_000;

    constructor(address _entryPoint) {
        entryPoint = IEntryPoint(_entryPoint);
    }

    // ─── Build a Claim UserOperation ─────────────────────────────────────────

    /// @notice Construct a ready-to-submit UserOp for a subscription claim.
    ///         Call this off-chain (eth_call) — do not send as transaction.
    /// @param wallet     The SubscriptionWallet to claim from.
    /// @param service    The whitelisted service claiming payment.
    /// @param maxFee     EIP-1559 maxFeePerGas (pass current basefee + tip).
    /// @param priorityFee EIP-1559 maxPriorityFeePerGas.
    function buildClaimOp(
        address wallet,
        address service,
        uint256 maxFee,
        uint256 priorityFee
    ) external view returns (UserOperation memory op) {
        // Subscription claim "signature": magic bytes + service address
        bytes memory sig = abi.encodePacked(
            SubscriptionWallet.CLAIM_MAGIC,
            abi.encode(service)
        );

        op = UserOperation({
            sender:               wallet,
            nonce:                entryPoint.getNonce(wallet, 0),
            initCode:             "",   // Wallet must already be deployed
            callData:             abi.encodeCall(SubscriptionWallet.executeClaim, (service)),
            callGasLimit:         DEFAULT_CALL_GAS_LIMIT,
            verificationGasLimit: DEFAULT_VERIFICATION_GAS_LIMIT,
            preVerificationGas:   DEFAULT_PRE_VERIFICATION_GAS,
            maxFeePerGas:         maxFee,
            maxPriorityFeePerGas: priorityFee,
            paymasterAndData:     "",   // Wallet self-pays from EntryPoint deposit
            signature:            sig
        });
    }

    // ─── Batch Check ─────────────────────────────────────────────────────────

    struct ClaimStatus {
        address wallet;
        address service;
        bool    isDue;
        bool    hasBalance;
        bool    isWhitelisted;
        uint256 nextClaimAt;
        uint256 amountPerCycle;
        uint256 walletBalance;
    }

    /// @notice Check claim status for multiple (wallet, service) pairs.
    ///         Bundlers poll this to find claimable subscriptions.
    function checkClaimable(
        address[] calldata wallets,
        address[] calldata services
    ) external view returns (ClaimStatus[] memory statuses) {
        require(wallets.length == services.length, "Length mismatch");
        statuses = new ClaimStatus[](wallets.length);

        for (uint256 i = 0; i < wallets.length; i++) {
            SubscriptionWallet w = SubscriptionWallet(payable(wallets[i]));
            address svc = services[i];

            SubscriptionWallet.Subscription memory sub = w.getSubscription(svc);

            uint256 bal = 0;
            if (sub.token != address(0)) {
                bal = IERC20(sub.token).balanceOf(wallets[i]);
            }

            statuses[i] = ClaimStatus({
                wallet:         wallets[i],
                service:        svc,
                isDue:          sub.active && block.timestamp >= sub.nextClaimAt,
                hasBalance:     bal >= sub.amountPerCycle,
                isWhitelisted:  w.registry().isWhitelisted(svc),
                nextClaimAt:    sub.nextClaimAt,
                amountPerCycle: sub.amountPerCycle,
                walletBalance:  bal
            });
        }
    }
}
