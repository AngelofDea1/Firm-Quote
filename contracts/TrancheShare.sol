// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Tranche} from "./interfaces/ITrancheVault.sol";

interface ITrancheAccountant {
    function trancheAssets(Tranche tranche) external view returns (uint256);
    function onDeposit(Tranche tranche, uint256 assets) external;
    function onWithdraw(Tranche tranche, uint256 assets, address receiver) external;
    function depositsOpen() external view returns (bool);
    function redemptionsOpen() external view returns (bool);
}

/**
 * @title TrancheShare
 * @notice A real ERC-4626 vault for one tranche class. Two of these are deployed per deal
 *         (senior + junior) and both point at the same TrancheVault accountant, which holds
 *         the cash and owns the loss waterfall.
 *
 * ERC-4626 is single-share-class by construction, so rather than bending the standard into
 * a two-class shape we deploy one compliant vault per class and centralise the accounting.
 * Share price falls out of the standard's own math on top of `totalAssets()`.
 *
 * Deliberate design choice: `maxWithdraw`/`maxRedeem` are ZERO until the deal settles. Holders
 * genuinely cannot get out through this contract before maturity. That is the point - it is
 * what makes the ExitLiquidityPool a real liquidity venue rather than decoration.
 */
contract TrancheShare is ERC4626 {
    ITrancheAccountant public immutable accountant;
    Tranche public immutable tranche;

    error OnlyAccountant();
    error DepositsClosed();
    error RedemptionsClosed();

    constructor(IERC20 asset_, string memory name_, string memory symbol_, address accountant_, Tranche tranche_)
        ERC20(name_, symbol_)
        ERC4626(asset_)
    {
        accountant = ITrancheAccountant(accountant_);
        tranche = tranche_;
    }

    /// @dev NAV for this class comes from the accountant, which is where losses are applied.
    function totalAssets() public view override returns (uint256) {
        return accountant.trancheAssets(tranche);
    }

    function maxDeposit(address) public view override returns (uint256) {
        return accountant.depositsOpen() ? type(uint256).max : 0;
    }

    function maxMint(address) public view override returns (uint256) {
        return accountant.depositsOpen() ? type(uint256).max : 0;
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        if (!accountant.redemptionsOpen()) return 0;
        return super.maxWithdraw(owner);
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (!accountant.redemptionsOpen()) return 0;
        return super.maxRedeem(owner);
    }

    /// @dev Cash goes straight to the accountant, never sits here.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        if (!accountant.depositsOpen()) revert DepositsClosed();
        SafeERC20.safeTransferFrom(IERC20(asset()), caller, address(accountant), assets);
        accountant.onDeposit(tranche, assets);
        _mint(receiver, shares);
        emit Deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        if (!accountant.redemptionsOpen()) revert RedemptionsClosed();
        if (caller != owner) {
            _spendAllowance(owner, caller, shares);
        }
        _burn(owner, shares);
        accountant.onWithdraw(tranche, assets, receiver);
        emit Withdraw(caller, receiver, owner, assets, shares);
    }
}
