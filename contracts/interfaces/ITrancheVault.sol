// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

enum Tranche {
    Senior,
    Junior
}

interface ITrancheVault {
    /// @notice UnderwriterVault pushes slashed bond in here; it becomes first-loss cover.
    function receiveBondProceeds(uint256 amount) external;

    /// @notice Apply a realised credit loss through the waterfall: bond -> junior -> senior.
    function settleLoss(uint256 loss) external;

    /// @notice Accounting assets attributable to one tranche.
    function trancheAssets(Tranche tranche) external view returns (uint256);
}
