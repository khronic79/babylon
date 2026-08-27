// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {SettelmentsControl} from "../../contracts/SettelmentsControl.sol";

contract SettelmentsControlFuzz is BaseTest {
    function setUp() public override {
        super.setUp();
        _setNative(native, NATIVE_PK, "native-1", "fuzz-native");
    }

    // F-2: fuzz математики комиссии (feeAmount = amount * pct / 100).
    function testFuzz_feeMath(uint256 amount, uint8 feePct) public {
        amount = bound(amount, 1, 1_000_000e18);
        uint256 pct = bound(uint256(feePct), 0, 100);

        vm.prank(owner);
        control.setFeeConfig(pct, feeCollector);

        _topUp(user1, USER1_PK, "alice", amount, bytes32("fee-math"));

        uint256 feeAmount = (amount * pct) / 100;
        uint256 amountToNative = amount - feeAmount;

        uint256 nativeBefore = token.balanceOf(native);
        uint256 collectorBefore = token.balanceOf(feeCollector);

        vm.prank(admin);
        control.paymentClientToNative(
            bytes32("pay-fee-math"),
            "alice",
            "native-1",
            amount,
            "s",
            block.timestamp,
            30
        );

        assertEq(feeAmount + amountToNative, amount, "fee + native == amount");
        assertEq(
            token.balanceOf(native),
            nativeBefore + amountToNative,
            "native gets amountToNative"
        );
        assertEq(
            token.balanceOf(feeCollector),
            collectorBefore + feeAmount,
            "collector gets feeAmount"
        );
        assertEq(control.getBalance("alice").balance, 0, "client fully settled");
    }

    // F-2: многошаговая последовательность на накопленных балансах.
    function testFuzz_feeMathMultiStep(
        uint256 a,
        uint256 b,
        uint256 pay,
        uint256 back,
        uint8 feePct
    ) public {
        a = bound(a, 1, 1e20);
        b = bound(b, 1, 1e20);
        uint256 pct = bound(uint256(feePct), 0, 100);
        uint256 total = a + b;
        pay = bound(pay, 1, total);
        back = bound(back, 0, total - pay);

        vm.prank(owner);
        control.setFeeConfig(pct, feeCollector);

        _topUp(user1, USER1_PK, "alice", a, bytes32("multi-1"));
        _topUp(user1, USER1_PK, "alice", b, bytes32("multi-2"));

        uint256 feeAmount = (pay * pct) / 100;
        uint256 amountToNative = pay - feeAmount;

        uint256 nativeBefore = token.balanceOf(native);
        uint256 collectorBefore = token.balanceOf(feeCollector);

        vm.prank(admin);
        control.paymentClientToNative(
            bytes32("pay-multi"),
            "alice",
            "native-1",
            pay,
            "s",
            block.timestamp,
            30
        );

        assertEq(feeAmount + amountToNative, pay, "fee + native == pay");
        assertEq(token.balanceOf(native), nativeBefore + amountToNative);
        assertEq(token.balanceOf(feeCollector), collectorBefore + feeAmount);
        assertEq(control.getBalance("alice").balance, total - pay);

        if (back > 0) {
            uint256 userBefore = token.balanceOf(user1);
            vm.prank(admin);
            control.backFundsToClient(bytes32("back-multi"), "alice", back);
            assertEq(token.balanceOf(user1), userBefore + back);
            assertEq(
                control.getBalance("alice").balance,
                total - pay - back
            );
        }

        assertEq(
            control.getTotalClientBalance(),
            control.getBalance("alice").balance
        );
    }

    // F-2: граница feePercentage == 0.
    function testFeeMath_zeroPercent() public {
        vm.prank(owner);
        control.setFeeConfig(0, feeCollector);

        uint256 amount = 1000e18;
        _topUp(user1, USER1_PK, "alice", amount, bytes32("zero"));

        uint256 nativeBefore = token.balanceOf(native);
        vm.prank(admin);
        control.paymentClientToNative(
            bytes32("pay-zero"),
            "alice",
            "native-1",
            amount,
            "s",
            block.timestamp,
            30
        );

        assertEq(token.balanceOf(native), nativeBefore + amount);
    }

    // F-2: граница feePercentage == 100.
    function testFeeMath_hundredPercent() public {
        vm.prank(owner);
        control.setFeeConfig(100, feeCollector);

        uint256 amount = 1000e18;
        _topUp(user1, USER1_PK, "alice", amount, bytes32("hundred"));

        uint256 collectorBefore = token.balanceOf(feeCollector);
        uint256 nativeBefore = token.balanceOf(native);
        vm.prank(admin);
        control.paymentClientToNative(
            bytes32("pay-hundred"),
            "alice",
            "native-1",
            amount,
            "s",
            block.timestamp,
            30
        );

        assertEq(token.balanceOf(feeCollector), collectorBefore + amount);
        assertEq(token.balanceOf(native), nativeBefore);
    }

    // F-3: edge-подписи (v ∉ {27,28}, arbitrary r/s, high-s) → InvalidSignature,
    // nonce не сжигается.
    function testFuzz_badSignature(uint8 v, bytes32 r, bytes32 s) public {
        string memory nonce = "bad-sig";
        vm.prank(admin);
        vm.expectRevert(SettelmentsControl.InvalidSignature.selector);
        control.setNativeAddressWithSignature(
            "native-1",
            native,
            nonce,
            block.timestamp + 3600,
            v,
            r,
            s
        );
        assertFalse(control.isNonceUsed(nonce));
    }

    // F-3: deadline в прошлом → SignatureExpired, nonce не сжигается.
    function testFuzz_signatureExpired(uint256 deadline) public {
        vm.warp(1_000_000);
        deadline = bound(deadline, 0, block.timestamp - 1);
        vm.prank(admin);
        vm.expectRevert(SettelmentsControl.SignatureExpired.selector);
        control.setNativeAddressWithSignature(
            "native-1",
            native,
            "expired",
            deadline,
            27,
            bytes32(0),
            bytes32(0)
        );
        assertFalse(control.isNonceUsed("expired"));
    }

    // F-3: валидные r/s, но неканоничный v (∉ {27,28}) → InvalidSignature,
    // nonce не сжигается.
    function testFuzz_nonCanonicalV(uint8 v) public {
        vm.assume(v != 27 && v != 28);
        string memory nonce = "bad-v";
        uint256 deadline = block.timestamp + 3600;
        (, bytes32 r, bytes32 s) = _signAssignment(
            NATIVE_PK,
            "native-1",
            native,
            nonce,
            deadline
        );
        vm.prank(admin);
        vm.expectRevert(SettelmentsControl.InvalidSignature.selector);
        control.setNativeAddressWithSignature(
            "native-1",
            native,
            nonce,
            deadline,
            v,
            r,
            s
        );
        assertFalse(control.isNonceUsed(nonce));
    }

    // F-3: deadline − now > maxValidity → DeadlineTooFar, nonce не сжигается.
    function testFuzz_deadlineTooFar(uint256 delta) public {
        delta = bound(delta, 1, 1_000_000);
        uint256 deadline = block.timestamp + maxValidity + delta;
        vm.prank(admin);
        vm.expectRevert(SettelmentsControl.DeadlineTooFar.selector);
        control.setNativeAddressWithSignature(
            "native-1",
            native,
            "too-far",
            deadline,
            27,
            bytes32(0),
            bytes32(0)
        );
        assertFalse(control.isNonceUsed("too-far"));
    }
}
