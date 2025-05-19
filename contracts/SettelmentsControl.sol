// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    SafeERC20
} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {
    Initializable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

contract SettelmentsControl is Multicall, Initializable {
    using SafeERC20 for IERC20;

    struct Balance {
        uint256 clientBalance;
        uint256 nativeBalance;
    }

    address public owner;

    event TopUpClientBalance(
        string userId,
        uint256 amount,
        uint256 currentClientBalance,
        address sender
    );
    event PaymentClientToNative(
        string clientId,
        uint256 clientBalance,
        string nativeId,
        uint256 nativeBalance,
        uint256 amount
    );
    event BalanceUpdated(address indexed user, uint256 newBalance);
    event WithdrawFundsToNative(
        string userId,
        address reciever,
        uint256 amount
    );
    event BackFundsToClient(string userId, address reciever, uint256 amount);
    event ChangeAdmin(address newAdmin);

    error OnlyAdmin();
    error InsufficientClientBalance(uint256 amount, uint256 clientBalance);
    error InsufficientNativeBalance(uint256 amount, uint256 nativeBalance);
    error NotThisBalanceType(uint256 balanceType);
    error InitializeOnlyByInitializer();

    // TODO При деплое необходимо изменить адрес
    address public constant INITIALIZER_ADDRESS =
        0x5c8630069c6663e7Fa3eAAAB562e2fF4419e12f7;

    // keccak256(abi.encode(uint256(keccak256("SettelmentControle.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0x52df78793d2feb0b7400eb8844c172999e80c8fc4fe2452bac344eccb4e8cb00;

    struct ContractStorage {
        mapping(bytes32 => Balance) balances;
        IERC20 token;
        address admin;
    }

    function _getContractStorage()
        private
        pure
        returns (ContractStorage storage $)
    {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    modifier onlyAdmin() {
        ContractStorage storage $ = _getContractStorage();
        if (msg.sender != $.admin) {
            revert OnlyAdmin();
        }
        _;
    }

    modifier onlyInitializer() {
        if (msg.sender != INITIALIZER_ADDRESS) {
            revert InitializeOnlyByInitializer();
        }
        _;
    }

    function initialize(
        address _token,
        address admin
    ) external initializer onlyInitializer {
        ContractStorage storage $ = _getContractStorage();
        $.token = IERC20(_token);
        $.admin = admin;
        emit ChangeAdmin(admin);
    }

    function topUpClientBalance(
        uint256 amount,
        string calldata userId
    ) external {
        ContractStorage storage $ = _getContractStorage();

        Balance storage clientBalance = $.balances[
            keccak256(abi.encodePacked(userId))
        ];

        $.token.safeTransferFrom(msg.sender, address(this), amount);

        clientBalance.clientBalance += amount;

        emit TopUpClientBalance(
            userId,
            amount,
            clientBalance.clientBalance,
            msg.sender
        );
    }

    function paymentClientToNative(
        string calldata clientId,
        string calldata nativeId,
        uint256 amount
    ) external onlyAdmin {
        ContractStorage storage $ = _getContractStorage();

        Balance storage clientBalanceRef = $.balances[
            keccak256(abi.encodePacked(clientId))
        ];
        Balance storage nativeBalanceRef = $.balances[
            keccak256(abi.encodePacked(nativeId))
        ];

        if (clientBalanceRef.clientBalance < amount) {
            revert InsufficientClientBalance(
                amount,
                clientBalanceRef.clientBalance
            );
        }

        clientBalanceRef.clientBalance -= amount;
        nativeBalanceRef.nativeBalance += amount;

        emit PaymentClientToNative(
            clientId,
            clientBalanceRef.clientBalance,
            nativeId,
            nativeBalanceRef.nativeBalance,
            amount
        );
    }

    function withdrawFundsToNative(
        string calldata userId,
        address receiver,
        uint256 amount
    ) external onlyAdmin {
        ContractStorage storage $ = _getContractStorage();
        Balance storage balanceRef = $.balances[
            keccak256(abi.encodePacked(userId))
        ];

        uint256 currentBalance = balanceRef.nativeBalance;
        if (currentBalance < amount) {
            revert InsufficientNativeBalance(amount, currentBalance);
        }

        balanceRef.nativeBalance = currentBalance - amount;
        $.token.safeTransfer(receiver, amount);

        emit WithdrawFundsToNative(userId, receiver, amount);
    }

    function backFundsToClient(
        string calldata userId,
        address receiver,
        uint256 amount
    ) external onlyAdmin {
        ContractStorage storage $ = _getContractStorage();
        Balance storage balanceRef = $.balances[
            keccak256(abi.encodePacked(userId))
        ];

        uint256 currentBalance = balanceRef.clientBalance;
        if (currentBalance < amount) {
            revert InsufficientNativeBalance(amount, currentBalance);
        }

        balanceRef.clientBalance = currentBalance - amount;

        $.token.safeTransfer(receiver, amount);

        emit BackFundsToClient(userId, receiver, amount);
    }

    function getBalance(
        string calldata userId
    ) external view returns (Balance memory) {
        bytes32 userHash = keccak256(abi.encodePacked(userId));
        ContractStorage storage $ = _getContractStorage();
        Balance memory userBalance = $.balances[userHash];
        return userBalance;
    }

    function withdrawTokens(address to, uint256 amount) external onlyAdmin {
        ContractStorage storage $ = _getContractStorage();
        $.token.safeTransfer(to, amount);
    }

    function changeAdmin(address newAdmin) external onlyAdmin {
        ContractStorage storage $ = _getContractStorage();
        $.admin = newAdmin;
        emit ChangeAdmin(newAdmin);
    }

    function getAdmin() external view returns (address) {
        ContractStorage storage $ = _getContractStorage();
        return $.admin;
    }
}
