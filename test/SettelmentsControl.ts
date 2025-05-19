import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import dotenv from "dotenv";

dotenv.config();

describe("SettelmentsControl", function () {
  async function deploySettelmentsControlFixture() {
    const [owner, admin, user1, user2] = await ethers.getSigners();

    const initializer = new ethers.Wallet(
      `0x${process.env.PRIVATE_KEY}`,
      ethers.provider,
    );

    const Token = await ethers.getContractFactory("ERC20Mock");
    const initialSupply = BigInt(1000000) * BigInt(10 ** 18);
    const token = await Token.deploy(
      "Test Token",
      "TTK",
      owner.address,
      initialSupply,
    );

    const SettelmentsControl =
      await ethers.getContractFactory("SettelmentsControl");
    const settlementsControl = await SettelmentsControl.deploy();

    await network.provider.send("hardhat_setBalance", [
      initializer.address,
      "0x" + ethers.parseEther("100").toString(16),
    ]);

    await settlementsControl
      .connect(initializer)
      .initialize(await token.getAddress(), admin.address);

    return { token, settlementsControl, owner, admin, user1, user2 };
  }

  describe("Initialization", function () {
    it("should set the correct admin and token", async function () {
      const { settlementsControl, admin } = await loadFixture(
        deploySettelmentsControlFixture,
      );

      expect(await settlementsControl.getAdmin()).to.equal(admin.address);
    });
  });

  describe("TopUpClientBalance", function () {
    it("should increase client balance correctly", async function () {
      const { token, settlementsControl, user1 } = await loadFixture(
        deploySettelmentsControlFixture,
      );

      const userId = "user123";
      const amount = 1000n;

      await token.mint(user1.address, amount);

      await token
        .connect(user1)
        .approve(await settlementsControl.getAddress(), amount);
      await expect(
        settlementsControl.connect(user1).topUpClientBalance(amount, userId),
      )
        .to.emit(settlementsControl, "TopUpClientBalance")
        .withArgs(userId, amount, amount, user1.address);

      const balance = await settlementsControl.getBalance(userId);
      expect(balance.clientBalance).to.equal(amount);
      expect(balance.nativeBalance).to.equal(0);
    });

    it("should reject if token transfer fails", async function () {
      const { token, settlementsControl, user1 } = await loadFixture(
        deploySettelmentsControlFixture,
      );

      const userId = "user123";
      const amount = 1000;

      await expect(
        settlementsControl.connect(user1).topUpClientBalance(amount, userId),
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
    });
  });

  describe("PaymentClientToNative", function () {
    it("should transfer funds from client to native correctly", async function () {
      const { token, settlementsControl, admin, user1 } = await loadFixture(
        deploySettelmentsControlFixture,
      );

      const clientId = "client123";
      const nativeId = "native456";
      const amount = 500;

      await token.mint(user1.address, amount);

      await token
        .connect(user1)
        .approve(await settlementsControl.getAddress(), amount);
      await settlementsControl
        .connect(user1)
        .topUpClientBalance(amount, clientId);

      await expect(
        settlementsControl
          .connect(admin)
          .paymentClientToNative(clientId, nativeId, amount),
      )
        .to.emit(settlementsControl, "PaymentClientToNative")
        .withArgs(clientId, 0, nativeId, amount, amount);

      const clientBalance = await settlementsControl.getBalance(clientId);
      const nativeBalance = await settlementsControl.getBalance(nativeId);

      expect(clientBalance.clientBalance).to.equal(0);
      expect(clientBalance.nativeBalance).to.equal(0);
      expect(nativeBalance.clientBalance).to.equal(0);
      expect(nativeBalance.nativeBalance).to.equal(amount);
    });

    it("should reject if not enough client balance", async function () {
      const { settlementsControl, admin } = await loadFixture(
        deploySettelmentsControlFixture,
      );

      const clientId = "client123";
      const nativeId = "native456";
      const amount = 500;

      await expect(
        settlementsControl
          .connect(admin)
          .paymentClientToNative(clientId, nativeId, amount),
      ).to.be.revertedWithCustomError(
        settlementsControl,
        "InsufficientClientBalance",
      );
    });

    it("should reject if called by non-admin", async function () {
      const { settlementsControl, user1 } = await loadFixture(
        deploySettelmentsControlFixture,
      );

      await expect(
        settlementsControl
          .connect(user1)
          .paymentClientToNative("client123", "native456", 100),
      ).to.be.revertedWithCustomError(settlementsControl, "OnlyAdmin");
    });
  });

  describe("WithdrawFundsToNative", function () {
    it("should withdraw native funds correctly", async function () {
      const { token, settlementsControl, admin, user1, user2 } =
        await loadFixture(deploySettelmentsControlFixture);

      const clientId = "tempClient";
      const nativeId = "native123";
      const amount = 300;
      const receiver = user2.address;

      await token.mint(user1.address, amount);

      await token
        .connect(user1)
        .approve(await settlementsControl.getAddress(), amount);
      await settlementsControl
        .connect(user1)
        .topUpClientBalance(amount, clientId);
      await settlementsControl
        .connect(admin)
        .paymentClientToNative(clientId, nativeId, amount);

      const initialReceiverBalance = await token.balanceOf(receiver);
      await expect(
        settlementsControl
          .connect(admin)
          .withdrawFundsToNative(nativeId, receiver, amount),
      )
        .to.emit(settlementsControl, "WithdrawFundsToNative")
        .withArgs(nativeId, receiver, amount);

      // Check balances
      const nativeBalance = await settlementsControl.getBalance(nativeId);
      expect(nativeBalance.nativeBalance).to.equal(0);
      expect(await token.balanceOf(receiver)).to.equal(
        initialReceiverBalance + BigInt(amount),
      );
    });

    it("should reject if not enough native balance", async function () {
      const { settlementsControl, admin, user2 } = await loadFixture(
        deploySettelmentsControlFixture,
      );

      await expect(
        settlementsControl
          .connect(admin)
          .withdrawFundsToNative("nonexistent", user2.address, 100),
      ).to.be.revertedWithCustomError(
        settlementsControl,
        "InsufficientNativeBalance",
      );
    });

    it("should reject if called by non-admin", async function () {
      const { settlementsControl, user1, user2 } = await loadFixture(
        deploySettelmentsControlFixture,
      );

      await expect(
        settlementsControl
          .connect(user1)
          .withdrawFundsToNative("any", user2.address, 100),
      ).to.be.revertedWithCustomError(settlementsControl, "OnlyAdmin");
    });
  });

  describe("BackFundsToClient", function () {
    it("should return client funds correctly", async function () {
      const { token, settlementsControl, admin, user1, user2 } =
        await loadFixture(deploySettelmentsControlFixture);

      const clientId = "client123";
      const amount = 200;
      const receiver = user2.address;

      await token.mint(user1.address, amount);

      await token
        .connect(user1)
        .approve(await settlementsControl.getAddress(), amount);
      await settlementsControl
        .connect(user1)
        .topUpClientBalance(amount, clientId);

      const initialReceiverBalance = await token.balanceOf(receiver);
      await expect(
        settlementsControl
          .connect(admin)
          .backFundsToClient(clientId, receiver, amount),
      )
        .to.emit(settlementsControl, "BackFundsToClient")
        .withArgs(clientId, receiver, amount);

      const clientBalance = await settlementsControl.getBalance(clientId);
      expect(clientBalance.clientBalance).to.equal(0);
      expect(await token.balanceOf(receiver)).to.equal(
        initialReceiverBalance + BigInt(amount),
      );
    });

    it("should reject if not enough client balance", async function () {
      const { settlementsControl, admin, user2 } = await loadFixture(
        deploySettelmentsControlFixture,
      );

      await expect(
        settlementsControl
          .connect(admin)
          .backFundsToClient("nonexistent", user2.address, 100),
      ).to.be.revertedWithCustomError(
        settlementsControl,
        "InsufficientNativeBalance",
      );
    });

    it("should reject if called by non-admin", async function () {
      const { settlementsControl, user1, user2 } = await loadFixture(
        deploySettelmentsControlFixture,
      );

      await expect(
        settlementsControl
          .connect(user1)
          .backFundsToClient("any", user2.address, 100),
      ).to.be.revertedWithCustomError(settlementsControl, "OnlyAdmin");
    });
  });

  describe("WithdrawTokens", function () {
    it("should allow admin to withdraw tokens", async function () {
      const { token, settlementsControl, admin, user1 } = await loadFixture(
        deploySettelmentsControlFixture,
      );

      const amount = 1000;
      const receiver = user1.address;

      await token.transfer(await settlementsControl.getAddress(), amount);

      const initialReceiverBalance = await token.balanceOf(receiver);
      await settlementsControl.connect(admin).withdrawTokens(receiver, amount);

      expect(await token.balanceOf(receiver)).to.equal(
        initialReceiverBalance + BigInt(amount),
      );
    });

    it("should reject if called by non-admin", async function () {
      const { settlementsControl, user1 } = await loadFixture(
        deploySettelmentsControlFixture,
      );

      await expect(
        settlementsControl.connect(user1).withdrawTokens(user1.address, 100),
      ).to.be.revertedWithCustomError(settlementsControl, "OnlyAdmin");
    });
  });
});
