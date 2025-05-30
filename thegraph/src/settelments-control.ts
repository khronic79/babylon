import {
  BackFundsToClient as BackFundsToClientEvent,
  BalanceUpdated as BalanceUpdatedEvent,
  ChangeAdmin as ChangeAdminEvent,
  Initialized as InitializedEvent,
  PaymentClientToNative as PaymentClientToNativeEvent,
  TopUpClientBalance as TopUpClientBalanceEvent,
  WithdrawFundsToNative as WithdrawFundsToNativeEvent
} from "../generated/SettelmentsControl/SettelmentsControl"
import {
  BackFundsToClient,
  BalanceUpdated,
  ChangeAdmin,
  ClientBalanceHistory,
  Counter,
  Initialized,
  NativeBalanceHistory,
  PaymentClientToNative,
  TopUpClientBalance,
  WithdrawFundsToNative,
} from "../generated/schema"
import { BigInt } from "@graphprotocol/graph-ts"

export function handleBackFundsToClient(event: BackFundsToClientEvent): void {
  let entity = new BackFundsToClient(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )

  entity.userId = event.params.userId
  entity.reciever = event.params.reciever
  entity.amount = event.params.amount

  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash

  entity.save()

  let counter = Counter.load('client')
  if (!counter) {
    counter = new Counter('client')
    counter.value = BigInt.fromI32(1);
  }

  let clientBalanceHistory = new ClientBalanceHistory(counter.value.toString())
  
  counter.value.plus(BigInt.fromI32(1))
  counter.save();

  clientBalanceHistory.txType = 'BACK_FUNDS';
  clientBalanceHistory.txDirection = 'OUT';
  clientBalanceHistory.txAccountigTime = event.block.timestamp
  clientBalanceHistory.txHash = event.transaction.hash
  clientBalanceHistory.amount = event.params.amount
  clientBalanceHistory.clientId = event.params.userId
  clientBalanceHistory.save()
}

export function handleBalanceUpdated(event: BalanceUpdatedEvent): void {
  let entity = new BalanceUpdated(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )
  entity.user = event.params.user
  entity.newBalance = event.params.newBalance

  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash

  entity.save()
}

export function handleChangeAdmin(event: ChangeAdminEvent): void {
  let entity = new ChangeAdmin(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )
  entity.newAdmin = event.params.newAdmin

  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash

  entity.save()
}

export function handleInitialized(event: InitializedEvent): void {
  let entity = new Initialized(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )
  entity.version = event.params.version

  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash

  entity.save()
}

export function handlePaymentClientToNative(
  event: PaymentClientToNativeEvent
): void {
  let entity = new PaymentClientToNative(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )
  entity.clientId = event.params.clientId
  entity.clientBalance = event.params.clientBalance
  entity.nativeId = event.params.nativeId
  entity.nativeBalance = event.params.nativeBalance
  entity.amount = event.params.amount
  entity.sessionId = event.params.sessionId
  entity.timestamp = event.params.timestamp
  entity.minutesQty = event.params.minutesQty

  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash

  entity.save()

  let clientCounter = Counter.load('client')
  if (!clientCounter) {
    clientCounter = new Counter('client')
    clientCounter.value = BigInt.fromI32(1);
  }

  let clientBalanceHistory = new ClientBalanceHistory(clientCounter.value.toString())
  
  clientCounter.value.plus(BigInt.fromI32(1))
  clientCounter.save();

  clientBalanceHistory.txType = 'SERVICE_FEE';
  clientBalanceHistory.txDirection = 'OUT';
  clientBalanceHistory.txAccountigTime = event.block.timestamp
  clientBalanceHistory.txHash = event.transaction.hash
  clientBalanceHistory.amount = event.params.amount
  clientBalanceHistory.clientId = event.params.clientId
  clientBalanceHistory.sessionId = event.params.sessionId
  clientBalanceHistory.sessionStartTime = event.params.timestamp
  clientBalanceHistory.minutesQty = event.params.minutesQty
  clientBalanceHistory.save()

  let nativeCounter = Counter.load('native')
  if (!nativeCounter) {
    nativeCounter = new Counter('native')
    nativeCounter.value = BigInt.fromI32(1);
  }

  let nativeBalanceHistory = new NativeBalanceHistory(nativeCounter.value.toString())
  
  nativeCounter.value.plus(BigInt.fromI32(1))
  nativeCounter.save();

  nativeBalanceHistory.txType = 'COMPENSATION';
  nativeBalanceHistory.txDirection = 'IN';
  nativeBalanceHistory.txAccountigTime = event.block.timestamp
  nativeBalanceHistory.txHash = event.transaction.hash
  nativeBalanceHistory.amount = event.params.amount
  nativeBalanceHistory.nativeId = event.params.nativeId
  nativeBalanceHistory.sessionId = event.params.sessionId
  nativeBalanceHistory.sessionStartTime = event.params.timestamp
  nativeBalanceHistory.minutesQty = event.params.minutesQty
  nativeBalanceHistory.save()

}

export function handleTopUpClientBalance(event: TopUpClientBalanceEvent): void {
  let entity = new TopUpClientBalance(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )
  entity.userId = event.params.userId
  entity.amount = event.params.amount
  entity.currentClientBalance = event.params.currentClientBalance
  entity.sender = event.params.sender

  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash

  entity.save()

  let clientCounter = Counter.load('client')
  if (!clientCounter) {
    clientCounter = new Counter('client')
    clientCounter.value = BigInt.fromI32(1);
  }

  let clientBalanceHistory = new ClientBalanceHistory(clientCounter.value.toString())
  
  clientCounter.value.plus(BigInt.fromI32(1))
  clientCounter.save();

  clientBalanceHistory.txType = 'TOPUP';
  clientBalanceHistory.txDirection = 'IN';
  clientBalanceHistory.txAccountigTime = event.block.timestamp
  clientBalanceHistory.txHash = event.transaction.hash
  clientBalanceHistory.amount = event.params.amount
  clientBalanceHistory.clientId = event.params.userId
  clientBalanceHistory.save()
}

export function handleWithdrawFundsToNative(
  event: WithdrawFundsToNativeEvent
): void {
  let entity = new WithdrawFundsToNative(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )
  entity.userId = event.params.userId
  entity.reciever = event.params.reciever
  entity.amount = event.params.amount

  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash

  entity.save()

  let nativeCounter = Counter.load('native')
  if (!nativeCounter) {
    nativeCounter = new Counter('native')
    nativeCounter.value = BigInt.fromI32(1);
  }

  let nativeBalanceHistory = new NativeBalanceHistory(nativeCounter.value.toString())
  
  nativeCounter.value.plus(BigInt.fromI32(1))
  nativeCounter.save();

  nativeBalanceHistory.txType = 'WITHDRAW';
  nativeBalanceHistory.txDirection = 'OUT';
  nativeBalanceHistory.txAccountigTime = event.block.timestamp
  nativeBalanceHistory.txHash = event.transaction.hash
  nativeBalanceHistory.amount = event.params.amount
  nativeBalanceHistory.nativeId = event.params.userId
  nativeBalanceHistory.save()
}
