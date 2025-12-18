import { ethers } from 'ethers';
import { encryptPrivateKey, decryptPrivateKey, EncryptedPayload } from "../helpers/secureCrypto";

// Interface for wallet data
export interface WalletData {
  address: string;
  encryptedPrivateKey: EncryptedPayload;
}

// Create a new wallet
export const createWallet = async (): Promise<ethers.HDNodeWallet> => {
  const wallet = ethers.Wallet.createRandom();
  return wallet;
};

// Import wallet from private key
export const importWalletFromPrivateKey = async (privateKey: string): Promise<ethers.HDNodeWallet | ethers.Wallet> => {
  try {
    // Validate private key format
    if (!privateKey.startsWith('0x')) {
      privateKey = '0x' + privateKey;
    }
    
    const wallet = new ethers.Wallet(privateKey);
    return wallet;
  } catch (error) {
    console.error('Invalid private key:', error);
    throw new Error('Invalid private key format');
  }
};

// Import wallet from mnemonic phrase
export const importWalletFromMnemonic = async (phrase: string): Promise<ethers.HDNodeWallet> => {
  try {
    const trimmed = phrase.trim();
    const wallet = ethers.Wallet.fromPhrase(trimmed);
    return wallet;
  } catch (error) {
    console.error('Invalid mnemonic phrase:', error);
    throw new Error('Invalid mnemonic phrase');
  }
};

// Encrypt wallet with password
export const encryptWallet = async (
  wallet: ethers.HDNodeWallet | ethers.Wallet,
  password: string
): Promise<WalletData> => {
  const privateKey = wallet.privateKey;
  const encryptedPrivateKey = await encryptPrivateKey(privateKey, password);

  return {
    address: wallet.address,
    encryptedPrivateKey,
  };
};

// Decrypt wallet with password
export const decryptWallet = async (
  walletData: WalletData,
  password: string
): Promise<ethers.HDNodeWallet | ethers.Wallet> => {
  try {
    const privateKey = await decryptPrivateKey(
      walletData.encryptedPrivateKey,
      password
    );

    if (!privateKey) {
      throw new Error("Incorrect password");
    }

    return new ethers.Wallet(privateKey);
  } catch (error) {
    console.error("Failed to decrypt wallet:", error);
    throw new Error("Incorrect password");
  }
};

// Save wallet to storage
export const saveWallet = async (walletData: WalletData): Promise<void> => {
  await chrome.storage.local.set({ walletData: walletData });
};

// Get wallet from storage
export const getWallet = async (): Promise<WalletData | null> => {
  const result = await chrome.storage.local.get(['walletData']);
  return result.walletData || null;
};

// Check if wallet is set up
export const isWalletSetup = async (): Promise<boolean> => {
  const result = await chrome.storage.local.get(['walletData']);
  return !!result.walletData;
};

