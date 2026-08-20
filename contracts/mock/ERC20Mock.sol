// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract ERC20Mock is ERC20, EIP712 {
    bytes32 private constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );

    mapping(address authorizer => mapping(bytes32 nonce => bool used))
        private _authorizationState;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error PayeeMustBeCaller();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidAuthorizationSignature();

    constructor(
        string memory name,
        string memory symbol,
        address initialAccount,
        uint256 initialBalance
    ) ERC20(name, symbol) EIP712(name, "2") {
        _mint(initialAccount, initialBalance);
    }

    function mint(address account, uint256 amount) public {
        _mint(account, amount);
    }

    function version() external pure returns (string memory) {
        return "2";
    }

    function authorizationState(
        address authorizer,
        bytes32 nonce
    ) external view returns (bool) {
        return _authorizationState[authorizer][nonce];
    }

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
    ) external {
        if (to != msg.sender) revert PayeeMustBeCaller();
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationState[from][nonce]) revert AuthorizationAlreadyUsed();

        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        address signer;
        ECDSA.RecoverError err;
        (signer, err, ) = ECDSA.tryRecover(
            _hashTypedDataV4(structHash),
            abi.encodePacked(r, s, v)
        );
        if (err != ECDSA.RecoverError.NoError || signer != from) {
            revert InvalidAuthorizationSignature();
        }

        _authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);

        _transfer(from, to, value);
    }
}
