// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    SafeERC20
} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    Initializable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    EIP712Upgradeable
} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";

interface IERC20WithAuthorization is IERC20 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s        
    ) external;
}


contract SettelmentsControl is Initializable, EIP712Upgradeable {
    using SafeERC20 for IERC20WithAuthorization;

    struct ClientBalance {
        uint256 balance;
        address lastInboundAddress;
    }

    struct NativeAddressAssignment {
        string nativeId;
        address nativeAddress;
        string nonce;
    }

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
        address nativeAddress,
        uint256 amountToNative,
        string sessionId,
        uint256 timestamp,
        uint256 minutesQty,
        uint256 feePercentage,
        uint256 feeAmount,
        address feeCollector
    );
    event NativeAddressSet(string indexed nativeId, address nativeAddress);
    event BackFundsToClient(string userId, address reciever, uint256 amount);
    event ChangeAdmin(address newAdmin);

    error OnlyAdmin();
    error OnlyOwner();
    error InsufficientClientBalanceForSessionSettelment(
        string clientId,
        uint256 clientBalance,
        string nativeId,
        address nativeAddress,
        uint256 amountToNative,
        string sessionId,
        uint256 timestamp,
        uint256 minutesQty,
        uint256 feePercentage,
        uint256 feeAmount,
        address feeCollector   
    );
    error NativeAddressIsOutForSessionSettelment(
        string clientId,
        uint256 clientBalance,
        string nativeId,
        address nativeAddress,
        uint256 amountToNative,
        string sessionId,
        uint256 timestamp,
        uint256 minutesQty,
        uint256 feePercentage,
        uint256 feeAmount,
        address feeCollector    
    );
    error InsufficientContractBalanceForSessionSettelment(
        string clientId,
        uint256 clientBalance,
        string nativeId,
        address nativeAddress,
        uint256 amountToNative,
        string sessionId,
        uint256 timestamp,
        uint256 minutesQty,
        uint256 feePercentage,
        uint256 feeAmount,
        address feeCollector    
    );

    error InsufficientClientBalanceForBackFunds(
        string clientId,
        address clientAddress,
        uint256 amount,
        uint256 clientBalance
    );

    error InsufficientContractBalanceForBackFunds(
        string clientId,
        address clientAddress,
        uint256 amount,
        uint256 clientBalance
    );
    error InvalidSignature();
    error NonceAlreadyUsed();
    error InvalidNativeAddress();
    error EmptyNativeId();
    error EmptyNonce();
    error FeeTooHigh(uint256 feePercentage);
    error InvalidFeeCollector();

    // keccak256(abi.encode(uint256(keccak256("SettelmentControle.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0x52df78793d2feb0b7400eb8844c172999e80c8fc4fe2452bac344eccb4e8cb00;

    bytes32 private constant ASSIGNMENT_TYPEHASH =
        keccak256("NativeAddressAssignment(string nativeId,address nativeAddress,string nonce)");

    struct ContractStorage {
        mapping(bytes32 => ClientBalance) clientBalances;
        mapping(bytes32 => address) nativeAddresses;
        mapping(bytes32 => bool) usedNonces;
        IERC20WithAuthorization token;
        address admin;
        address owner;
        uint256 feePercentage;
        address feeCollector;
    }

    constructor() {
        _disableInitializers();
    }

    function _getContractStorage()
        private
        pure
        returns (ContractStorage storage $)
    {
        // solhint-disable-next-line no-inline-assembly
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

    modifier onlyOwner() {
        ContractStorage storage $ = _getContractStorage();
        if (msg.sender != $.owner) {
            revert OnlyOwner();
        }
        _;
    }

    function initialize(
        address _token,
        address _admin,
        address _owner,
        uint256 _feePercentage,
        address _feeCollector
    ) external initializer {
        __EIP712_init("SettelmentsControl", "1.0");
        if (_feePercentage > 100) revert FeeTooHigh(_feePercentage);
        ContractStorage storage $ = _getContractStorage();
        $.token = IERC20WithAuthorization(_token);
        $.admin = _admin;
        $.owner = _owner;
        $.feePercentage = _feePercentage;
        $.feeCollector = _feeCollector;
        emit ChangeAdmin(_admin);
    }

    function topUpClientBalance(
        string calldata userId,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external onlyAdmin {
        ContractStorage storage $ = _getContractStorage();

        ClientBalance storage clientBalance = $.clientBalances[
            keccak256(abi.encodePacked(userId))
        ];

        $.token.receiveWithAuthorization(
            from,
            address(this),
            value,
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s
        );

        clientBalance.balance += value;
        clientBalance.lastInboundAddress = from;

        emit TopUpClientBalance(
            userId,
            value,
            clientBalance.balance,
            from
        );
    }

    function paymentClientToNative(
        string calldata clientId,
        string calldata nativeId,
        uint256 amount,
        string calldata sessionId,
        uint256 timestamp,
        uint256 minutesQty
    ) external onlyAdmin {
        require(amount > 0, "Settlement amount between client and native must be > 0");

        ContractStorage storage $ = _getContractStorage();

        ClientBalance storage clientBalance = $.clientBalances[
            keccak256(abi.encodePacked(clientId))
        ];

        uint256 clientBalanceAmount = clientBalance.balance;

        address nativeAddress = $.nativeAddresses[
            keccak256(abi.encodePacked(nativeId))
        ];

        uint256 feeAmount = 0;

        address feeCollector = $.feeCollector;

        uint256 feePercentage = $.feePercentage;
        
        feeAmount = (amount * feePercentage) / 100;
        
        uint256 amountToNative = amount - feeAmount;

        if (nativeAddress == address(0)) {
            revert NativeAddressIsOutForSessionSettelment(
                clientId,
                clientBalanceAmount,
                nativeId,
                nativeAddress,
                amount,
                sessionId,
                timestamp,
                minutesQty,
                feePercentage,
                feeAmount,
                feeCollector
            );
        }

        if (clientBalanceAmount < amount) {
            revert InsufficientClientBalanceForSessionSettelment(
                clientId,
                clientBalanceAmount,
                nativeId,
                nativeAddress,
                amount,
                sessionId,
                timestamp,
                minutesQty,
                feePercentage,
                feeAmount,
                feeCollector
            );
        }

        IERC20WithAuthorization token = $.token;

        uint256 contractBalance = token.balanceOf(address(this));

        if (contractBalance < amount) {
            revert InsufficientContractBalanceForSessionSettelment(
                clientId,
                clientBalanceAmount,
                nativeId,
                nativeAddress,
                amount,
                sessionId,
                timestamp,
                minutesQty,
                feePercentage,
                feeAmount,
                feeCollector
            );
        }

        if (amountToNative > 0) {
            token.safeTransfer(nativeAddress, amountToNative);
        }

        if (feeAmount > 0) {
            token.safeTransfer(feeCollector, feeAmount);
        }

        clientBalance.balance -= amount;

        emit PaymentClientToNative(
            clientId,
            clientBalanceAmount,
            nativeId,
            nativeAddress,
            amount,
            sessionId,
            timestamp,
            minutesQty,
            feePercentage,
            feeAmount,
            feeCollector
        );
    }

    function backFundsToClient(
        string calldata userId,
        uint256 amount
    ) external onlyAdmin {
        require(amount > 0, "Back fund amount to client must be > 0");
        ContractStorage storage $ = _getContractStorage();
        ClientBalance storage balance = $.clientBalances[
            keccak256(abi.encodePacked(userId))
        ];
        address lastAddress = balance.lastInboundAddress;
        uint256 currentBalance = balance.balance;
        if (currentBalance < amount) {
            revert InsufficientClientBalanceForBackFunds(
                userId,
                lastAddress,
                amount,
                currentBalance
            );
        }

        IERC20WithAuthorization token = $.token;

        uint256 contractBalance = token.balanceOf(address(this));

        if (contractBalance < amount) {
            revert InsufficientContractBalanceForBackFunds(
                userId,
                lastAddress,
                amount,
                currentBalance
            );
        }
        
        token.safeTransfer(lastAddress, amount);

        balance.balance = currentBalance - amount;

        emit BackFundsToClient(userId, lastAddress, amount);
    }

    function getBalance(
        string calldata userId
    ) external view returns (ClientBalance memory) {
        bytes32 userHash = keccak256(abi.encodePacked(userId));
        ContractStorage storage $ = _getContractStorage();
        ClientBalance memory userBalance = $.clientBalances[userHash];
        return userBalance;
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

    function isNonceUsed(string calldata nonce) external view returns (bool) {
        ContractStorage storage $ = _getContractStorage();
        bytes32 nonceHash = keccak256(abi.encodePacked(nonce));
        return $.usedNonces[nonceHash];
    }

    function setNativeAddressWithSignature(
        string calldata nativeId,
        address nativeAddress,
        string calldata nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external onlyAdmin {

        if (bytes(nativeId).length == 0) {
            revert EmptyNativeId();
        }
        if (nativeAddress == address(0)) {
            revert InvalidNativeAddress();
        }
        if (bytes(nonce).length == 0) {
            revert EmptyNonce();
        }

        ContractStorage storage $ = _getContractStorage();

        bytes32 nonceHash = keccak256(abi.encodePacked(nonce));
        if ($.usedNonces[nonceHash]) {
            revert NonceAlreadyUsed();
        }

        bytes32 structHash = keccak256(
            abi.encode(
                ASSIGNMENT_TYPEHASH,
                keccak256(bytes(nativeId)),
                nativeAddress,
                keccak256(bytes(nonce))
            )
        );
        
        bytes32 digest = _hashTypedDataV4(structHash);
        
        address signer = ecrecover(digest, v, r, s);

        if (signer == address(0)) {
            revert InvalidSignature();
        }

        $.usedNonces[nonceHash] = true;

        bytes32 nativeHash = keccak256(abi.encodePacked(nativeId));

        $.nativeAddresses[nativeHash] = nativeAddress;

        emit NativeAddressSet(nativeId, nativeAddress);
    }

    function getNativeAddress(
        string calldata nativeId
    ) external view returns (address) {
        bytes32 nativeHash = keccak256(abi.encodePacked(nativeId));
        ContractStorage storage $ = _getContractStorage();
        return $.nativeAddresses[nativeHash];
    }

    function isNativeAddressSet(
        string calldata nativeId
    ) external view returns (bool) {
        bytes32 nativeHash = keccak256(abi.encodePacked(nativeId));
        ContractStorage storage $ = _getContractStorage();
        return $.nativeAddresses[nativeHash] != address(0);
    }

    function setFeeConfig(
        uint256 feePercentage,
        address feeCollector
    ) external onlyAdmin {
        if (feePercentage > 100) revert FeeTooHigh(feePercentage);
        if (feeCollector == address(0)) revert InvalidFeeCollector();
        
        ContractStorage storage $ = _getContractStorage();
        $.feePercentage = feePercentage;
        $.feeCollector = feeCollector;
    }

    function getFeeConfig() external view returns (uint256 feePercentage, address feeCollector) {
        ContractStorage storage $ = _getContractStorage();
        return ($.feePercentage, $.feeCollector);
    }
}
