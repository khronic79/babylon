import { newMockEvent } from "matchstick-as"
import { ethereum, Address, BigInt } from "@graphprotocol/graph-ts"
import {
  BackFundsToClient,
  BalanceUpdated,
  ChangeAdmin,
  Initialized,
  PaymentClientToNative,
  TopUpClientBalance,
  WithdrawFundsToNative
} from "../generated/SettelmentsControl/SettelmentsControl"

export function createBackFundsToClientEvent(
  userId: string,
  reciever: Address,
  amount: BigInt
): BackFundsToClient {
  let backFundsToClientEvent = changetype<BackFundsToClient>(newMockEvent())

  backFundsToClientEvent.parameters = new Array()

  backFundsToClientEvent.parameters.push(
    new ethereum.EventParam("userId", ethereum.Value.fromString(userId))
  )
  backFundsToClientEvent.parameters.push(
    new ethereum.EventParam("reciever", ethereum.Value.fromAddress(reciever))
  )
  backFundsToClientEvent.parameters.push(
    new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(amount))
  )

  return backFundsToClientEvent
}

export function createBalanceUpdatedEvent(
  user: Address,
  newBalance: BigInt
): BalanceUpdated {
  let balanceUpdatedEvent = changetype<BalanceUpdated>(newMockEvent())

  balanceUpdatedEvent.parameters = new Array()

  balanceUpdatedEvent.parameters.push(
    new ethereum.EventParam("user", ethereum.Value.fromAddress(user))
  )
  balanceUpdatedEvent.parameters.push(
    new ethereum.EventParam(
      "newBalance",
      ethereum.Value.fromUnsignedBigInt(newBalance)
    )
  )

  return balanceUpdatedEvent
}

export function createChangeAdminEvent(newAdmin: Address): ChangeAdmin {
  let changeAdminEvent = changetype<ChangeAdmin>(newMockEvent())

  changeAdminEvent.parameters = new Array()

  changeAdminEvent.parameters.push(
    new ethereum.EventParam("newAdmin", ethereum.Value.fromAddress(newAdmin))
  )

  return changeAdminEvent
}

export function createInitializedEvent(version: BigInt): Initialized {
  let initializedEvent = changetype<Initialized>(newMockEvent())

  initializedEvent.parameters = new Array()

  initializedEvent.parameters.push(
    new ethereum.EventParam(
      "version",
      ethereum.Value.fromUnsignedBigInt(version)
    )
  )

  return initializedEvent
}

export function createPaymentClientToNativeEvent(
  clientId: string,
  clientBalance: BigInt,
  nativeId: string,
  nativeBalance: BigInt,
  amount: BigInt,
  sessionId: string,
  timestamp: BigInt,
  minutesQty: BigInt
): PaymentClientToNative {
  let paymentClientToNativeEvent =
    changetype<PaymentClientToNative>(newMockEvent())

  paymentClientToNativeEvent.parameters = new Array()

  paymentClientToNativeEvent.parameters.push(
    new ethereum.EventParam("clientId", ethereum.Value.fromString(clientId))
  )
  paymentClientToNativeEvent.parameters.push(
    new ethereum.EventParam(
      "clientBalance",
      ethereum.Value.fromUnsignedBigInt(clientBalance)
    )
  )
  paymentClientToNativeEvent.parameters.push(
    new ethereum.EventParam("nativeId", ethereum.Value.fromString(nativeId))
  )
  paymentClientToNativeEvent.parameters.push(
    new ethereum.EventParam(
      "nativeBalance",
      ethereum.Value.fromUnsignedBigInt(nativeBalance)
    )
  )
  paymentClientToNativeEvent.parameters.push(
    new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(amount))
  )
  paymentClientToNativeEvent.parameters.push(
    new ethereum.EventParam("sessionId", ethereum.Value.fromString(sessionId))
  )
  paymentClientToNativeEvent.parameters.push(
    new ethereum.EventParam(
      "timestamp",
      ethereum.Value.fromUnsignedBigInt(timestamp)
    )
  )
  paymentClientToNativeEvent.parameters.push(
    new ethereum.EventParam(
      "minutesQty",
      ethereum.Value.fromUnsignedBigInt(minutesQty)
    )
  )

  return paymentClientToNativeEvent
}

export function createTopUpClientBalanceEvent(
  userId: string,
  amount: BigInt,
  currentClientBalance: BigInt,
  sender: Address
): TopUpClientBalance {
  let topUpClientBalanceEvent = changetype<TopUpClientBalance>(newMockEvent())

  topUpClientBalanceEvent.parameters = new Array()

  topUpClientBalanceEvent.parameters.push(
    new ethereum.EventParam("userId", ethereum.Value.fromString(userId))
  )
  topUpClientBalanceEvent.parameters.push(
    new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(amount))
  )
  topUpClientBalanceEvent.parameters.push(
    new ethereum.EventParam(
      "currentClientBalance",
      ethereum.Value.fromUnsignedBigInt(currentClientBalance)
    )
  )
  topUpClientBalanceEvent.parameters.push(
    new ethereum.EventParam("sender", ethereum.Value.fromAddress(sender))
  )

  return topUpClientBalanceEvent
}

export function createWithdrawFundsToNativeEvent(
  userId: string,
  reciever: Address,
  amount: BigInt
): WithdrawFundsToNative {
  let withdrawFundsToNativeEvent =
    changetype<WithdrawFundsToNative>(newMockEvent())

  withdrawFundsToNativeEvent.parameters = new Array()

  withdrawFundsToNativeEvent.parameters.push(
    new ethereum.EventParam("userId", ethereum.Value.fromString(userId))
  )
  withdrawFundsToNativeEvent.parameters.push(
    new ethereum.EventParam("reciever", ethereum.Value.fromAddress(reciever))
  )
  withdrawFundsToNativeEvent.parameters.push(
    new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(amount))
  )

  return withdrawFundsToNativeEvent
}
