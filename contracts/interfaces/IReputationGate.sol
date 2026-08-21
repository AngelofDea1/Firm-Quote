// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Why an underwriter was allowed through the gate, or turned away.
/// @dev Surfaced in the demo UI so a judge sees the *reason*, not just a boolean.
enum GateReason {
    Eligible,
    NotRegistered,
    FlaggedForCollusion,
    WalletTooYoung,
    ScoreTooLow,
    SharedFundingSource,
    RepeatedCounterparty
}

interface IReputationGate {
    /// @notice Spec-shaped eligibility check.
    /// @return eligible          whether this underwriter may underwrite this counterparty
    /// @return requiredBondMultiplierBps  bond multiple in bps (10_000 == 1.0x)
    function checkEligibility(address underwriter, address counterparty)
        external
        view
        returns (bool eligible, uint256 requiredBondMultiplierBps);

    /// @notice Same check, but says why. Used by the frontend and by tests.
    function checkEligibilityDetailed(address underwriter, address counterparty)
        external
        view
        returns (bool eligible, uint256 requiredBondMultiplierBps, GateReason reason);

    /// @notice Called by an approved consumer (UnderwriterVault) when a prediction is posted.
    function recordUnderwriting(address underwriter, address counterparty) external;

    /// @notice Called by an approved consumer when an outcome resolves, to move the track record.
    function recordResolution(address underwriter, bool slashed) external;
}
