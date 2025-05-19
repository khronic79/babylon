// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    ERC1967Proxy
} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {
    ERC1967Utils
} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

contract SettelmentsControlProxy is ERC1967Proxy {
    error OnlyAdmin();
    error NotAcceptEtherDirectly();

    constructor(address implementation) ERC1967Proxy(implementation, "") {
        ERC1967Utils.changeAdmin(msg.sender);
    }

    // Модификатор, который контролирует исполнение функции только от имени админа
    modifier onlyProxyAdmin() {
        address ca = ERC1967Utils.getAdmin();
        if (msg.sender != ca) {
            revert OnlyAdmin();
        }
        _;
    }

    // Функция, меняющая админа
    function changeProxyAdmin(address newAdmin) external onlyProxyAdmin {
        ERC1967Utils.changeAdmin(newAdmin);
    }

    // Функция получения админа
    function getProxyAdmin() external view returns (address admin) {
        return ERC1967Utils.getAdmin();
    }

    // Функция получения имплементации
    function getImpl() external view returns (address impl) {
        return _implementation();
    }

    // Функция установки новой имплементации
    function setImpl(address implementation) external onlyProxyAdmin {
        ERC1967Utils.upgradeToAndCall(implementation, "");
    }

    // Запрет на передачу ether
    receive() external payable {
        revert NotAcceptEtherDirectly();
    }
}
