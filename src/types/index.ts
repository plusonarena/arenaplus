import { ethers } from 'ethers'

export interface WalletInfo {
  address: string;
  privateKey: string;
  mnemonic: string;
  provider?: ethers.Provider;
}

export interface EncryptedPayload {
  salt: number[];
  iv: number[];
  ciphertext: number[];
}

export interface TokenInfo {
  balance: string;
  symbol: string;
  decimals: number;
  address?: string;
}

export interface TokensInfo {
  arena: TokenInfo;
  avax: TokenInfo;
}

export interface StoredWalletData {
  encryptedPrivateKey: EncryptedPayload;
  address: string;
}
