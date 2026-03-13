// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  PlatformRegistry
/// @notice Platform admin maintains a whitelist of approved subscription services.
///         SubscriptionWallets only allow claims from whitelisted services.
///         This replaces the old "bundler whitelist" with a proper service registry.
contract PlatformRegistry {

    // ─── State ───────────────────────────────────────────────────────────────

    address public admin;
    address public pendingAdmin; // Two-step admin transfer for safety

    struct ServiceInfo {
        string  name;
        string  description;
        address operator;   // Who manages the service contract
        uint256 addedAt;
        bool    active;
    }

    mapping(address => ServiceInfo) private _services;
    address[]                       public  serviceList;

    // ─── Events ──────────────────────────────────────────────────────────────

    event ServiceAdded(
        address indexed service,
        address indexed operator,
        string  name
    );
    event ServiceRemoved(address indexed service);
    event ServiceUpdated(address indexed service, string name);
    event AdminTransferInitiated(address indexed newAdmin);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        require(msg.sender == admin, "PlatformRegistry: not admin");
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor() {
        admin = msg.sender;
    }

    // ─── Admin: Service Management ───────────────────────────────────────────

    /// @notice Whitelist a new service.
    /// @param service     The service contract address users will subscribe to.
    /// @param operator    Address responsible for managing this service.
    /// @param name        Human-readable service name.
    /// @param description Short description shown in UIs.
    function addService(
        address service,
        address operator,
        string calldata name,
        string calldata description
    ) external onlyAdmin {
        require(service   != address(0), "Zero service address");
        require(operator  != address(0), "Zero operator address");
        require(bytes(name).length > 0,  "Empty name");
        require(!_services[service].active, "Already whitelisted");

        _services[service] = ServiceInfo({
            name:        name,
            description: description,
            operator:    operator,
            addedAt:     block.timestamp,
            active:      true
        });
        serviceList.push(service);

        emit ServiceAdded(service, operator, name);
    }

    /// @notice Remove a service from the whitelist.
    ///         Existing subscriptions will stop being claimable immediately.
    function removeService(address service) external onlyAdmin {
        require(_services[service].active, "Not active");
        _services[service].active = false;
        emit ServiceRemoved(service);
    }

    /// @notice Update a service's metadata (not the contract address).
    function updateService(
        address service,
        string calldata name,
        string calldata description
    ) external onlyAdmin {
        require(_services[service].active, "Service not active");
        _services[service].name        = name;
        _services[service].description = description;
        emit ServiceUpdated(service, name);
    }

    // ─── Admin Transfer (Two-step) ───────────────────────────────────────────

    function initiateAdminTransfer(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Zero address");
        pendingAdmin = newAdmin;
        emit AdminTransferInitiated(newAdmin);
    }

    function acceptAdminTransfer() external {
        require(msg.sender == pendingAdmin, "Not pending admin");
        emit AdminTransferred(admin, pendingAdmin);
        admin        = pendingAdmin;
        pendingAdmin = address(0);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    /// @notice Primary check used by SubscriptionWallet during validation.
    function isWhitelisted(address service) external view returns (bool) {
        return _services[service].active;
    }

    function getService(address service)
        external view
        returns (ServiceInfo memory)
    {
        return _services[service];
    }

    function getServiceCount() external view returns (uint256) {
        return serviceList.length;
    }

    /// @notice Returns the active subset of the list (for front-end pagination).
    function getActiveServices(uint256 offset, uint256 limit)
        external view
        returns (address[] memory result, uint256 total)
    {
        uint256 len  = serviceList.length;
        uint256 end  = offset + limit > len ? len : offset + limit;
        result = new address[](end - offset);
        uint256 idx;
        for (uint256 i = offset; i < end; i++) {
            if (_services[serviceList[i]].active) {
                result[idx++] = serviceList[i];
            }
        }
        // Resize to actual count
        assembly { mstore(result, idx) }
        total = len;
    }
}
