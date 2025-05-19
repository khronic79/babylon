import Web3 from "web3";
const web3 = new Web3();

function calculateStorageSlot() {
  // 1. Вычисляем keccak256("add.storage")
  const labelHash = web3.utils.keccak256("SettelmentControle.storage");

  // 2. Преобразуем в BigInt и вычитаем 1
  const numericHash = BigInt(labelHash) - 1n;

  // 3. Кодируем в ABI формат (32 байта)
  const encoded = web3.eth.abi.encodeParameter("uint256", numericHash);

  // 4. Вычисляем keccak256 от закодированных данных
  const slotHash = web3.utils.keccak256(encoded);

  // 5. Создаём маску (обнуляем последний байт)
  const mask = BigInt(
    "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00",
  );
  const finalSlot = BigInt(slotHash) & mask;

  // Возвращаем как hex строку с 0x
  return "0x" + finalSlot.toString(16).padStart(64, "0");
}

const storageSlot = calculateStorageSlot();
console.log("Storage Slot:", storageSlot);
