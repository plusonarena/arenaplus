import { ethers } from "ethers";
import { ARENA_TOKEN, PLUS_TOKEN, TOKENS_MAP } from "../constants";
import { WalletInfo } from "../types";
import { AVALANCHE_RPC } from "../constants";
import { twitterLogin } from "./auth";
import { supabase } from "../supabaseClient";
import { StorageClient, immutable } from "@lens-chain/storage-client";
import { chains } from "@lens-chain/sdk/viem";
import { createScopedLogger } from "./core/logger";
import { createWalletActionQueue } from "./features/walletActionQueue";
import { fetchArenaTokenPrice } from "./features/arenaPrice";
import { unlockAndInitializeWallet } from "./features/walletUnlock";
import { ERC20_ABI, fetchErc20Metadata } from "./features/erc20";
import { getPost2EarnContract, getPost2EarnAddressOrThrow } from "./features/post2earnClient";

// Token monitoring has been removed

const logBackground = createScopedLogger("Background");

logBackground("Background script loading...");

let isUnlocked = false;
let inMemoryWallet: WalletInfo | null = null;
let nonce: number | null = null;
let twitterUser: any = null;
let createPromotionInFlight = false;
let engageInPromotionInFlight = false;
let cancelPromotionInFlight = false;
const walletActions = createWalletActionQueue(logBackground);

const formatAddressShort = (address?: string) => {
  if (!address || address.length < 10) return address || "Unknown";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

const isTrustedSender = (sender: chrome.runtime.MessageSender) => {
  if (sender.id && chrome.runtime?.id && sender.id === chrome.runtime.id) {
    return true;
  }

  const origin =
    sender.origin ||
    sender.url ||
    sender.tab?.url ||
    sender.documentId ||
    "";

  return typeof origin === "string"
    ? origin.startsWith("https://arena.social") ||
        origin.startsWith("https://www.x.com") ||
        origin.startsWith("https://x.com")
    : false;
};

async function executeSendTip(message: any) {
  if (!isUnlocked || !inMemoryWallet) {
    return { success: false, error: "Wallet is locked." };
  }
  if (nonce === null) {
    return {
      success: false,
      error: "Nonce not initialized. Please wait a moment and try again.",
    };
  }

  try {
    const { toAddress, amount, tokenAddress } = message;
    const signer = new ethers.Wallet(
      inMemoryWallet.privateKey,
      inMemoryWallet.provider
    );
    const token = new ethers.Contract(
      tokenAddress || PLUS_TOKEN.address,
      ARENA_TOKEN.abi || [],
      signer
    );

    const currentNonce = nonce;
    nonce++; // reserve nonce for next tx

    const decimals = await token.decimals();
    const parsedAmount = ethers.parseUnits(amount, decimals);
    const balance: bigint = await token.balanceOf(signer.address);
    if (balance < parsedAmount) {
      return { success: false, error: "INSUFFICIENT_BALANCE" };
    }

    const tx = await token.transfer(toAddress, parsedAmount, {
      nonce: currentNonce,
    });

    logBackground(
      `Tip transaction submitted: ${tx.hash} with nonce ${currentNonce}. Waiting for confirmation...`
    );

    tx.wait()
      .then(() => {
        logBackground(`Tip transaction confirmed: ${tx.hash}`);
        chrome.runtime.sendMessage({ type: "BALANCE_UPDATED" });
      })
      .catch((err: any) =>
        logBackground("Tip confirmation wait failed (non-critical):", err)
      );

    return { success: true, txHash: tx.hash };
  } catch (err: any) {
    logBackground("Error sending tip:", err);
    if (
      err?.code === "REPLACEMENT_UNDERPRICED" ||
      err?.code === "NONCE_EXPIRED"
    ) {
      logBackground("Nonce error detected, re-syncing nonce...");
      try {
        const signer = new ethers.Wallet(
          inMemoryWallet!.privateKey,
          inMemoryWallet!.provider
        );
        nonce = await signer.getNonce("latest");
        logBackground(`Nonce re-synced to ${nonce}`);
      } catch (e) {
        logBackground("Failed to re-sync nonce:", e);
      }
    }
    return {
      success: false,
      error:
        err?.message ||
        err?.reason ||
        err?.shortMessage ||
        "Failed to send tip",
    };
  }
}

type TipShowerRecipient = {
  handle: string;
  address: string;
};

type TipShowerBatchPayload = {
  recipients: TipShowerRecipient[];
  amountPerTip: string;
  tokenSymbol?: string;
  tokenAddress?: string;
  contextId?: string;
  tabId?: number;
};

type TipShowerProgressStatus = "processing" | "completed" | "failed";

const IGNORED_MESSAGE_ERRORS = new Set<string>([
  "The message port closed before a response was received.",
  "Could not establish connection. Receiving end does not exist.",
]);

const sendTipShowerMessage = (
  payload: Record<string, any>,
  context: string,
  tabId?: number
) => {
  const sendViaRuntime = () => {
    try {
      chrome.runtime.sendMessage(payload, () => {
        const message = chrome.runtime.lastError?.message;
        if (message && !IGNORED_MESSAGE_ERRORS.has(message)) {
          logBackground(`Failed to send ${context}:`, message);
        }
      });
    } catch (err) {
      logBackground(`Failed to send ${context}`, err);
    }
  };

  if (typeof tabId === "number" && tabId >= 0) {
    try {
      chrome.tabs.sendMessage(tabId, payload, () => {
        const message = chrome.runtime.lastError?.message;
        if (!message) return;
        if (IGNORED_MESSAGE_ERRORS.has(message)) {
          return;
        }
        if (message.includes("Receiving end does not exist")) {
          sendViaRuntime();
        } else {
          logBackground(`Failed to send ${context} to tab ${tabId}:`, message);
        }
      });
      return;
    } catch (err) {
      logBackground(`Failed to send ${context} to tab ${tabId}`, err);
    }
  }

  sendViaRuntime();
};

const notifyTipShowerProgress = (
  contextId: string | undefined,
  processed: number,
  total: number,
  status: TipShowerProgressStatus,
  error?: string,
  tabId?: number
) => {
  if (!contextId) return;
  sendTipShowerMessage(
    {
      type: "TIP_SHOWER_PROGRESS",
      contextId,
      processed,
      total,
      status,
      error,
    },
    "tip shower progress",
    tabId
  );
};

type PendingTipShowerApproval = {
  amountPerTip: string;
  tokenSymbol: string;
  tokenAddress?: string;
  queueId?: string;
  approved: boolean;
  tabId?: number;
};

const pendingTipShowerApprovals = new Map<string, PendingTipShowerApproval>();

// Create Promotion Approval Types & State
type PendingCreatePromotionApproval = {
  promotionType: number;
  slots: number;
  amount: number;
  minFollowers: number;
  expiresOn: number;
  postId: string;
  contentURI: string;
  rewardTokenAddress: string;
  rewardTokenSymbol: string;
  queueId?: string;
  approved: boolean;
  tabId?: number;
  arenaUserId: string;
};

const pendingCreatePromotionApprovals = new Map<string, PendingCreatePromotionApproval>();

const sendPromotionMessage = (
  payload: any,
  reason: string,
  tabId?: number
) => {
  if (typeof tabId === "number") {
    chrome.tabs.sendMessage(tabId, payload).catch((err) => {
      console.warn(`[AREX] Failed to send ${reason} message to tab ${tabId}:`, err);
    });
  } else {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, payload).catch(() => { });
        }
      });
    });
  }
};

const notifyCreatePromotionApprovalEvent = (
  contextId: string | undefined,
  tabId: number | undefined,
  type: "CREATE_PROMOTION_APPROVAL_GRANTED" | "CREATE_PROMOTION_APPROVAL_DENIED",
  error?: string
) => {
  if (!contextId) return;
  sendPromotionMessage(
    {
      type,
      contextId,
      error,
    },
    "create promotion approval",
    tabId
  );
};

const notifyCreatePromotionApprovalGranted = (
  contextId?: string,
  tabId?: number
) => notifyCreatePromotionApprovalEvent(contextId, tabId, "CREATE_PROMOTION_APPROVAL_GRANTED");

const notifyCreatePromotionApprovalDenied = (
  contextId?: string,
  tabId?: number,
  error?: string
) =>
  notifyCreatePromotionApprovalEvent(
    contextId,
    tabId,
    "CREATE_PROMOTION_APPROVAL_DENIED",
    error
  );

const notifyTipShowerApprovalEvent = (
  contextId: string | undefined,
  tabId: number | undefined,
  type: "TIP_SHOWER_APPROVAL_GRANTED" | "TIP_SHOWER_APPROVAL_DENIED",
  error?: string
) => {
  if (!contextId) return;
  sendTipShowerMessage(
    {
      type,
      contextId,
      error,
    },
    "tip shower approval",
    tabId
  );
};

const notifyTipShowerApprovalGranted = (
  contextId?: string,
  tabId?: number
) => notifyTipShowerApprovalEvent(contextId, tabId, "TIP_SHOWER_APPROVAL_GRANTED");

const notifyTipShowerApprovalDenied = (
  contextId?: string,
  tabId?: number,
  error?: string
) =>
  notifyTipShowerApprovalEvent(
    contextId,
    tabId,
    "TIP_SHOWER_APPROVAL_DENIED",
    error
  );

async function executeTipShowerBatch(payload: TipShowerBatchPayload) {
  if (!isUnlocked || !inMemoryWallet) {
    return { success: false, error: "Wallet is locked." };
  }
  if (!payload.recipients?.length) {
    return { success: false, error: "No tip recipients provided." };
  }
  const tokenSymbol = (payload.tokenSymbol || "PLUS").toUpperCase();
  const tokenAddress =
    payload.tokenAddress || TOKENS_MAP[tokenSymbol]?.address || PLUS_TOKEN.address;
  let processed = 0;
  const tabId = payload.tabId;

  try {
    notifyTipShowerProgress(
      payload.contextId,
      0,
      payload.recipients.length,
      "processing",
      undefined,
      tabId
    );
    for (const recipient of payload.recipients) {
      const result = await executeSendTip({
        toAddress: recipient.address,
        amount: payload.amountPerTip,
        tokenAddress,
        tokenSymbol,
        recipientHandle: recipient.handle,
      });
      if (!result.success) {
        notifyTipShowerProgress(
          payload.contextId,
          processed,
          payload.recipients.length,
          "failed",
          result.error,
          tabId
        );
        return {
          success: false,
          error: result.error || "Failed to complete tip shower.",
        };
      }
      processed += 1;
      notifyTipShowerProgress(
        payload.contextId,
        processed,
        payload.recipients.length,
        processed === payload.recipients.length ? "completed" : "processing",
        undefined,
        tabId
      );
    }
    return { success: true };
  } catch (err: any) {
    notifyTipShowerProgress(
      payload.contextId,
      processed,
      payload.recipients.length,
      "failed",
      err?.message || String(err),
      tabId
    );
    return {
      success: false,
      error: err?.message || "Tip shower failed.",
    };
  }
}

async function executeCreatePromotion(payload: any) {
  if (!isUnlocked || !inMemoryWallet) {
    return { success: false, error: "Wallet is locked." };
  }
  if (nonce === null) {
    return {
      success: false,
      error: "Nonce not initialized. Please wait a moment and try again.",
    };
  }
  if (createPromotionInFlight) {
    return {
      success: false,
      error: "Another promotion is in progress. Please wait.",
    };
  }

  createPromotionInFlight = true;
  try {
    logBackground("CREATE_PROMOTION received", payload);
    const {
      promotionType,
      slots,
      amount,
      minFollowers,
      expiresOn,
      postId,
      contentURI = "",
      content = "",
      rewardTokenAddress,
      arenaUserId
    } = payload;

    if (!postId) {
      logBackground("CREATE_PROMOTION: Missing postId");
      return { success: false, error: "Missing postId." };
    }
    if (!slots || slots < 1) {
      logBackground("CREATE_PROMOTION: Invalid slots value", slots);
      return { success: false, error: "Slots must be at least 1." };
    }
    if (!amount || amount <= 0) {
      logBackground("CREATE_PROMOTION: Invalid amount value", amount);
      return { success: false, error: "Amount must be greater than 0." };
    }
    if (!arenaUserId) {
      logBackground("CREATE_PROMOTION: Missing arenaUserId");
      return { success: false, error: "Arena User ID is required." };
    }

    const signer = new ethers.Wallet(
      inMemoryWallet.privateKey,
      inMemoryWallet.provider
    );
    let post2EarnCA: string;
    let contract: any;
    try {
      post2EarnCA = getPost2EarnAddressOrThrow();
      contract = getPost2EarnContract(signer);
    } catch (e: any) {
      return { success: false, error: e?.message || "Invalid Post2Earn contract address." };
    }
    logBackground(`CREATE_PROMOTION: Using Post2Earn at ${post2EarnCA}`);

    let onchainRewardToken = rewardTokenAddress;
    if (!onchainRewardToken) {
      onchainRewardToken = await contract.platformToken();
    }

    if (
      !onchainRewardToken ||
      !ethers.isAddress(onchainRewardToken) ||
      onchainRewardToken === ethers.ZeroAddress
    ) {
      return {
        success: false,
        error: "Invalid reward token address returned by contract.",
      };
    }
    logBackground(
      `CREATE_PROMOTION: Resolved reward token ${onchainRewardToken}`
    );
    const token = new ethers.Contract(onchainRewardToken, ERC20_ABI, signer);

    let tokenDecimalsRaw: any = 18;
    try {
      tokenDecimalsRaw = await token.decimals();
    } catch (_) {
      logBackground(
        "CREATE_PROMOTION: decimals() not available on token, assuming 18"
      );
    }
    const tokenDecimals =
      typeof tokenDecimalsRaw === "bigint"
        ? Number(tokenDecimalsRaw)
        : Number(tokenDecimalsRaw);
    if (!Number.isFinite(tokenDecimals)) {
      logBackground(
        `CREATE_PROMOTION: Could not parse token decimals (typeof=${typeof tokenDecimalsRaw}), assuming 18`
      );
    }
    // Removed check that tokenDecimals must be 18, as different tokens might have different decimals.

    const vaultAmount = ethers.parseUnits(amount.toString(), tokenDecimals);
    const rewardPerSlot = vaultAmount / BigInt(slots);

    if (slots < 1) {
      logBackground(`CREATE_PROMOTION: Invalid slots ${slots}`);
      return {
        success: false,
        error: "Slots must be at least 1.",
      };
    }
    // Removed hardcoded minVault check for "PLUS" token specifically, as other tokens might have different values.
    // But we should check for 0 amount
    if (vaultAmount <= 0n) {
      return { success: false, error: "Vault amount must be greater than 0." };
    }

    const nowTs = Math.floor(Date.now() / 1000);
    if (Number(expiresOn) <= nowTs) {
      logBackground(
        `CREATE_PROMOTION: Expiry in past nowTs=${nowTs} expiresOn=${expiresOn}`
      );
      return { success: false, error: "Expiry must be in the future." };
    }
    if (rewardPerSlot <= 0n) {
      logBackground("CREATE_PROMOTION: Reward per slot computed as 0");
      return {
        success: false,
        error: "Amount too low for given slots.",
      };
    }

    const signerAddress = signer.address;
    const balance: bigint = await token.balanceOf(signerAddress);
    if (balance < vaultAmount) {
      const need = ethers.formatUnits(vaultAmount, tokenDecimals);
      const have = ethers.formatUnits(balance, tokenDecimals);
      logBackground(
        `CREATE_PROMOTION: Insufficient balance. Need ${need}, have ${have}`
      );
      return {
        success: false,
        error: `Insufficient balance. Need ${need}, have ${have}.`,
      };
    }

    const currentAllowance: bigint = await token.allowance(
      signerAddress,
      contract.target
    );
    const baseNonce = await signer.getNonce("pending");
    let promoNonce = baseNonce;
    if (currentAllowance < vaultAmount) {
      const approveNonce = baseNonce;
      logBackground(
        `CREATE_PROMOTION: Approving allowance from ${ethers.formatUnits(
          currentAllowance,
          tokenDecimals
        )} to ${ethers.formatUnits(
          vaultAmount,
          tokenDecimals
        )} (nonce=${approveNonce})`
      );
      const approveTx = await token.approve(contract.target, vaultAmount, {
        nonce: approveNonce,
      });
      logBackground(
        `CREATE_PROMOTION: Approve tx submitted ${approveTx.hash}`
      );
      const approveRcpt = await approveTx.wait();
      logBackground(
        `CREATE_PROMOTION: Approve tx confirmed in block ${approveRcpt.blockNumber}`
      );
      promoNonce = baseNonce + 1;
    } else {
      logBackground(
        `CREATE_PROMOTION: Existing allowance sufficient: ${ethers.formatUnits(
          currentAllowance,
          tokenDecimals
        )}`
      );
    }

    logBackground(
      `CREATE_PROMOTION: Submitting createPromotion (nonce=${promoNonce}) type=${promotionType} slots=${slots} vault=${vaultAmount.toString()} minFollowers=${minFollowers} expiresOn=${expiresOn} postId=${postId}`
    );
    // Updated contract call signature
    const tx = await contract.createPromotion(
      onchainRewardToken,
      promotionType,
      slots,
      vaultAmount,
      minFollowers,
      expiresOn,
      postId,
      contentURI,
      content,
      arenaUserId,
      { nonce: promoNonce }
    );
    nonce = promoNonce + 1;

    logBackground(`Promotion transaction submitted: ${tx.hash}`);

    tx.wait()
      .then(() => {
        logBackground(`Promotion transaction confirmed: ${tx.hash}`);
        chrome.runtime.sendMessage({ type: "BALANCE_UPDATED" });
      })
      .catch((err: any) =>
        logBackground("Promotion confirmation wait failed:", err)
      );

    return { success: true, txHash: tx.hash };
  } catch (err: any) {
    const reason =
      err?.reason ||
      err?.shortMessage ||
      err?.data?.message ||
      err?.error?.message ||
      err?.message ||
      "Transaction failed";
    logBackground("Error creating promotion:", reason, err);

    if (
      err?.code === "REPLACEMENT_UNDERPRICED" ||
      err?.code === "NONCE_EXPIRED" ||
      /nonce (too low|already used)/i.test(String(reason))
    ) {
      logBackground("Nonce error detected, re-syncing nonce...");
      try {
        const n = await new ethers.Wallet(
          inMemoryWallet!.privateKey,
          inMemoryWallet!.provider
        ).getNonce("latest");
        nonce = n;
        logBackground(`Nonce re-synced to ${nonce}`);
      } catch (e) {
        logBackground("Failed to re-sync nonce:", e);
      }
    }
    return {
      success: false,
      error: reason,
    };
  } finally {
    createPromotionInFlight = false;
  }
}

async function executeSubscribeToToken(payload: any) {
  if (!isUnlocked || !inMemoryWallet) {
    return { success: false, error: "Wallet is locked." };
  }
  if (nonce === null) {
    return {
      success: false,
      error: "Nonce not initialized. Please wait a moment and try again.",
    };
  }

  try {
    logBackground("SUBSCRIBE_TO_TOKEN received", payload);
    const { tokenAddress, arenaUserId, months } = payload;

    if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
      return { success: false, error: "Invalid token address." };
    }
    if (!arenaUserId) {
      return { success: false, error: "Arena User ID is required." };
    }
    if (!months || months < 1) {
      return { success: false, error: "Invalid duration." };
    }

    const signer = new ethers.Wallet(
      inMemoryWallet.privateKey,
      inMemoryWallet.provider
    );
    let contract: any;
    try {
      contract = getPost2EarnContract(signer);
    } catch (e: any) {
      return { success: false, error: e?.message || "Invalid Post2Earn contract address." };
    }

    const fee: bigint = await contract.subscriptionFee();
    const totalFee = fee * BigInt(months);

    const balance: bigint = await signer.provider!.getBalance(signer.address);
    if (balance < totalFee) {
      return { success: false, error: "Insufficient AVAX balance for subscription fee." };
    }

    const baseNonce = await signer.getNonce("pending");
    logBackground(`SUBSCRIBE_TO_TOKEN: Submitting subscribe (nonce=${baseNonce})`);

    const tx = await contract.subscribe(tokenAddress, arenaUserId, months, {
      value: totalFee,
      nonce: baseNonce
    });

    nonce = baseNonce + 1;

    logBackground(`Subscription transaction submitted: ${tx.hash}`);

    tx.wait()
      .then(() => {
        logBackground(`Subscription transaction confirmed: ${tx.hash}`);
        chrome.runtime.sendMessage({ type: "BALANCE_UPDATED" });
      })
      .catch((err: any) =>
        logBackground("Subscription confirmation wait failed:", err)
      );

    return { success: true, txHash: tx.hash };

  } catch (err: any) {
    const reason = err?.reason || err?.message || "Subscription failed";
    logBackground("Error subscribing:", reason, err);

    if (
      err?.code === "REPLACEMENT_UNDERPRICED" ||
      err?.code === "NONCE_EXPIRED" ||
      /nonce (too low|already used)/i.test(String(reason))
    ) {
      logBackground("Nonce error detected, re-syncing nonce...");
      try {
        const n = await new ethers.Wallet(
          inMemoryWallet!.privateKey,
          inMemoryWallet!.provider
        ).getNonce("latest");
        nonce = n;
        logBackground(`Nonce re-synced to ${nonce}`);
      } catch (e) {
        logBackground("Failed to re-sync nonce:", e);
      }
    }

    return { success: false, error: reason };
  }
}

// Immediately check for an existing session when the script starts.
const initializeSession = async () => {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session) {
      twitterUser = session.user;
      await chrome.storage.session.set({ twitterUser });
    }
  } catch (e) {
    logBackground(`Error initializing session: ${e}`);
  }
};

initializeSession();

supabase.auth.onAuthStateChange((event, session) => {
  logBackground(`Auth state changed: ${event}`);
  if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
    twitterUser = session?.user ?? null;
    chrome.storage.session.set({ twitterUser });
    // Send an update to the UI
    chrome.runtime.sendMessage({ type: "SESSION_UPDATED", session });
  } else if (event === "SIGNED_OUT") {
    twitterUser = null;
    chrome.storage.session.remove("twitterUser");
    chrome.runtime.sendMessage({ type: "SESSION_UPDATED", session: null });
  }
});

// Restore other non-auth state when the service worker starts
chrome.storage.session
  .get(["isUnlocked", "wallet"])
  .then((data) => {
    logBackground("Restored session state from chrome.storage.session");
    isUnlocked = !!data.isUnlocked;
    inMemoryWallet = data.wallet ?? null;
    if (isUnlocked && inMemoryWallet) {
      const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC);
      inMemoryWallet = {
        ...inMemoryWallet,
        provider,
      } as WalletInfo;
      logBackground("Session wallet restored");

      // Initialize nonce when wallet is restored
      const signer = new ethers.Wallet(inMemoryWallet.privateKey, provider);
      signer
        .getNonce("latest")
        .then((n) => {
          nonce = n;
          logBackground(`Nonce initialized to ${nonce}`);
        })
        .catch((err) =>
          logBackground("Failed to initialize nonce on restore", err)
        );
    }
  })
  .catch((err) => logBackground("Failed to restore session", err));

// Background script
chrome.runtime.onInstalled.addListener(() => {
  logBackground("Extension installed and ready");

  // Open welcome page on installation
  chrome.tabs.create({
    url: "welcome.html",
  });
});

// NOTE: Previous bearer-token interception has been removed to avoid capturing
// and persisting sensitive auth headers.

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "TWITTER_LOGIN":
      twitterLogin()
        .then((response) => {
          sendResponse({ success: true, data: response });
        })
        .catch((error) => {
          sendResponse({ success: false, error: error.message });
        });
      return true; // Required for async response

    case "GET_APP_STATE":
      logBackground("Received GET_APP_STATE, fetching fresh session...");
      (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        twitterUser = session?.user ?? null;
        sendResponse({
          isUnlocked,
          wallet: inMemoryWallet,
          twitterUser,
        });
      })();
      return true; // Indicate that the response is asynchronous.

    case "LOCK_WALLET":
      isUnlocked = false;
      inMemoryWallet = null;
      nonce = null; // Clear nonce on lock
      chrome.storage.session.remove(["isUnlocked", "wallet"]);
      sendResponse({ success: true });
      return true;

    case "FETCH_PROMOTIONS_FILTERED":
      (async () => {
        try {
          const provider =
            inMemoryWallet?.provider || new ethers.JsonRpcProvider(AVALANCHE_RPC);
          let contract: any;
          try {
            contract = getPost2EarnContract(provider);
          } catch (e: any) {
            sendResponse({
              success: false,
              error: e?.message || "Invalid Post2Earn contract address.",
            });
            return;
          }

          const options = message.payload || {};
          const sortKey = (options.sortKey || "latest") as
            | "latest"
            | "oldest"
            | "vault"
            | "engagers";
          const offset = Number(options.offset || 0);
          const limit = Number(options.limit || 10);
          const newestFirst = Boolean(
            options.newestFirst ?? sortKey !== "oldest"
          );
          const minEngagers = Number(options.minEngagers || 0);
          const maxEngagers = Number(
            options.maxEngagers != null
              ? options.maxEngagers
              : Number.MAX_SAFE_INTEGER
          );

          // Parse PLUS amounts to 18-decimal units
          const parsePlus = (v: any): bigint => {
            if (v == null || v === "" || Number.isNaN(Number(v))) return 0n;
            try {
              return ethers.parseUnits(String(v), 18);
            } catch {
              return 0n;
            }
          };
          const minVault =
            options.minVaultPlus != null ? parsePlus(options.minVaultPlus) : 0n;
          const maxVault =
            options.maxVaultPlus != null
              ? parsePlus(options.maxVaultPlus)
              : ethers.MaxUint256;

          let ids: any[] = [];
          if (sortKey === "latest") {
            ids = await contract.getActivePromotionsByLatest(offset, limit);
          } else if (sortKey === "oldest") {
            ids = await contract.getActivePromotionsByOldest(offset, limit);
          } else if (sortKey === "vault") {
            ids = await contract.getActivePromotionsByVaultAmount(
              minVault,
              maxVault,
              offset,
              limit,
              newestFirst
            );
          } else if (sortKey === "engagers") {
            const maxEng = BigInt(maxEngagers);
            ids = await contract.getActivePromotionsByEngagersRange(
              BigInt(minEngagers),
              maxEng,
              offset,
              limit,
              newestFirst
            );
          }

          const idNums: number[] = (ids || []).map((x: any) =>
            Number(typeof x === "bigint" ? x : x)
          );

          const data = await Promise.all(
            idNums.map(async (i) => {
              try {
                const [p, engagementsCountRaw] = await Promise.all([
                  contract.getPromotionDetails(i),
                  contract.getEngagementsCount(i),
                ]);
                const engagementsCount =
                  typeof engagementsCountRaw === "bigint"
                    ? Number(engagementsCountRaw)
                    : Number(engagementsCountRaw);

                const normalized = {
                  id: i,
                  promoter: p.promoter,
                  promotionType: Number(
                    (p.promotionType as any)?.toString?.() ??
                    (p.promotionType as any)
                  ),
                  slotsAvailable: Number((p.slotsAvailable as any) ?? 0),
                  slotsTaken: Number((p.slotsTaken as any) ?? 0),
                  vaultAmount:
                    (p.vaultAmount as any)?.toString?.() ?? String(p.vaultAmount),
                  rewardPerSlot:
                    (p.rewardPerSlot as any)?.toString?.() ??
                    String(p.rewardPerSlot),
                  minFollowers: Number((p.minFollowers as any) ?? 0),
                  expiresOn: Number((p.expiresOn as any) ?? 0),
                  postId: p.postId,
                  contentURI: p.contentURI,
                  contentHash:
                    (p.contentHash as any)?.toString?.() ?? String(p.contentHash),
                  rewardToken: p.rewardToken,
                  active: Boolean(p.active),
                  engagementsCount,
                };
                return normalized;
              } catch (e) {
                logBackground(`FETCH_PROMOTIONS_FILTERED: Failed for id=${i}`, e);
                return { id: i, error: String(e) } as any;
              }
            })
          );

          sendResponse({ success: true, data });
        } catch (err: any) {
          logBackground("FETCH_PROMOTIONS_FILTERED error:", err);
          sendResponse({ success: false, error: err?.message || String(err) });
        }
      })();

      return true;

    case "UNLOCK_WALLET":
      const { password } = message;
      unlockAndInitializeWallet(password, logBackground)
        .then((wallet) => {
          inMemoryWallet = wallet;
          isUnlocked = true;
          const { address, privateKey, mnemonic } = wallet;
          chrome.storage.session.set({
            isUnlocked: true,
            wallet: { address, privateKey, mnemonic },
          });

          // Initialize nonce
          const signer = new ethers.Wallet(privateKey, wallet.provider);
          signer
            .getNonce("latest")
            .then((n) => {
              nonce = n;
              logBackground(`Nonce initialized to ${nonce}`);
              sendResponse({ success: true, wallet });
            })
            .catch((error) => {
              sendResponse({ success: false, error: error.message });
            });
        })
        .catch((error) => {
          sendResponse({ success: false, error: error.message });
        });
      return true;

    // Token monitoring functionality has been removed

    case "CHECK_WALLET_SETUP":
      chrome.storage.local.get(["walletData"], (result) => {
        sendResponse({
          isSetup: !!result.walletData,
        });
      });
      return true; // Required for async response

    case "FETCH_DEV_TRADES":
      const { tokenAddress, userAddress } = message.payload;
      logBackground(
        `Fetching dev trades for ${tokenAddress} and user ${userAddress}`
      );
      const tradesUrl = `${import.meta.env.VITE_ARENAPRO_API_URL || "https://api.arenapro.io"}/dex_trades_view?token_contract_address=eq.${tokenAddress.toLowerCase()}&order=create_time.desc&limit=1000&offset=0&sender_address=eq.${userAddress}`;

      fetch(tradesUrl)
        .then((response) => {
          if (!response.ok) {
            // Try to parse the error body to send more details back
            return response.json().then((errorBody) => {
              throw {
                status: response.status,
                statusText: response.statusText,
                body: errorBody,
              };
            });
          }
          return response.json();
        })
        .then((data) => {
          sendResponse({ success: true, data });
        })
        .catch((error) => {
          console.error("Error fetching dev trades:", error);
          sendResponse({ success: false, error });
        });

      return true; // Required for async response

    case "TWITTER_LOGOUT":
      supabase.auth.signOut().then(({ error }) => {
        if (error) {
          logBackground("Error logging out:", error);
          sendResponse({ success: false, error: error.message });
        } else {
          logBackground("User logged out successfully");
          sendResponse({ success: true });
        }
      });
      return true;

    case "FETCH_PRESALE_TRADES":
      const { tokenAddress: presaleTokenAddress, userAddress: presaleUserAddress } = message.payload;
      logBackground(
        `Fetching presale trades for ${presaleTokenAddress} and user ${presaleUserAddress}`
      );
      const presaleTradesUrl = `${import.meta.env.VITE_ARENAPRO_API_URL || "https://api.arenapro.io"}/token_trades_view?token_contract_address=eq.${presaleTokenAddress.toLowerCase()}&order=create_time.desc&limit=15&offset=0&user_address=eq.${presaleUserAddress.toLowerCase()}`;

      fetch(presaleTradesUrl)
        .then((response) => {
          if (!response.ok) {
            // Try to parse the error body to send more details back
            return response.json().then((errorBody) => {
              throw {
                status: response.status,
                statusText: response.statusText,
                body: errorBody,
              };
            });
          }
          return response.json();
        })
        .then((data) => {
          sendResponse({ success: true, data });
        })
        .catch((error) => {
          console.error("Error fetching presale trades:", error);
          sendResponse({ success: false, error });
        });

      return true; // Required for async response

    // Handle API requests to fetch ARENA token price
    case "FETCH_ARENA_PRICE":
      logBackground("Fetching ARENA token price...");

      // Background script can make API calls without CORS restrictions
      fetchArenaTokenPrice()
        .then((data) => {
          logBackground("ARENA price data:", data);
          sendResponse(data);
        })
        .catch((error) => {
          console.error("Error fetching ARENA price:", error);
          sendResponse({ error: "Failed to fetch price data" });
        });

      return true; // Required for async response

    case "SEND_TIP": {
      if (!isTrustedSender(sender)) {
        sendResponse({ success: false, error: "Unauthorized sender" });
        return false;
      }

      const { amount, tokenSymbol, recipientHandle, toAddress } = message;

      walletActions.enqueue(
        {
          title: "Send Tip",
          description: recipientHandle
            ? `Tip @${recipientHandle}`
            : `Tip ${formatAddressShort(toAddress)}`,
          amount: amount?.toString?.() ?? String(amount ?? ""),
          tokenSymbol: tokenSymbol || "PLUS",
        },
        () => executeSendTip(message),
        sendResponse
      );
      return true;
    }

    case "REQUEST_TIP_SHOWER_APPROVAL":
      const payload = message.payload || {};
      const contextId = String(payload.contextId || "");
      const count = Number(payload.count || payload.totalPosts || 0);
      const amountPerTip = String(payload.amountPerTip ?? payload.amount ?? "");
      const tokenSymbol_req = (payload.tokenSymbol || "PLUS").toUpperCase();
      const requestTabId = sender.tab?.id;

      if (!contextId) {
        sendResponse({ success: false, error: "Missing tip shower context." });
        return false;
      }
      if (pendingTipShowerApprovals.has(contextId)) {
        sendResponse({
          success: false,
          error: "A tip shower approval is already pending.",
        });
        return false;
      }
      if (!count || count <= 0) {
        sendResponse({ success: false, error: "Invalid post count." });
        return false;
      }
      if (!amountPerTip || Number(amountPerTip) <= 0) {
        sendResponse({ success: false, error: "Invalid tip amount." });
        return false;
      }
      const tokenConfig = TOKENS_MAP[tokenSymbol_req];
      if (!tokenConfig) {
        sendResponse({ success: false, error: "Unsupported token." });
        return false;
      }

      const description = count === 1 ? "Tip 1 post" : `Tip ${count} posts`;
      const approvalResponseHandler = (payload: any) => {
        if (!payload?.success) {
          const pendingEntry = pendingTipShowerApprovals.get(contextId);
          const targetTabId = pendingEntry?.tabId ?? requestTabId;
          pendingTipShowerApprovals.delete(contextId);
          notifyTipShowerApprovalDenied(
            contextId,
            targetTabId,
            payload?.error || "Wallet approval was rejected."
          );
        }
      };

      const queueId = walletActions.enqueue(
        {
          title: "Tip Shower",
          description,
          amount: `${amountPerTip} x ${count}`,
          tokenSymbol: tokenSymbol_req,
        },
        async () => {
          const pending = pendingTipShowerApprovals.get(contextId);
          if (!pending) {
            notifyTipShowerApprovalDenied(
              contextId,
              requestTabId,
              "Tip shower request expired."
            );
            return { success: false, error: "Tip shower request expired." };
          }
          pending.approved = true;
          notifyTipShowerApprovalGranted(contextId, pending.tabId ?? requestTabId);
          return { success: true };
        },
        approvalResponseHandler
      );

      pendingTipShowerApprovals.set(contextId, {
        amountPerTip,
        tokenSymbol: tokenSymbol_req,
        tokenAddress: tokenConfig.address,
        queueId,
        approved: false,
        tabId: requestTabId,
      });

      sendResponse({ success: true });
      return false;

    case "CANCEL_TIP_SHOWER_APPROVAL":
      const contextId_cancel = String(message.contextId || message.payload?.contextId || "");
      if (!contextId_cancel) {
        sendResponse({ success: false, error: "Missing tip shower context." });
        return false;
      }
      const pending_cancel = pendingTipShowerApprovals.get(contextId_cancel);
      if (!pending_cancel) {
        sendResponse({ success: false, error: "No pending approval to cancel." });
        return false;
      }
      const reason =
        message.reason || message.payload?.reason || "Tip shower cancelled.";
      if (!pending_cancel.approved && pending_cancel.queueId) {
        walletActions.cancelById(pending_cancel.queueId, reason);
      }
      pendingTipShowerApprovals.delete(contextId_cancel);
      sendResponse({ success: true });
      return false;

    case "REQUEST_CREATE_PROMOTION_APPROVAL":
      const promoPayload = message.payload || {};
      const promoContextId = String(promoPayload.contextId || "");
      const promoType = Number(promoPayload.promotionType ?? 0);
      const promoSlots = Number(promoPayload.slots || 0);
      const promoAmount = Number(promoPayload.amount || 0);
      const promoMinFollowers = Number(promoPayload.minFollowers || 0);
      const promoExpiresOn = Number(promoPayload.expiresOn || 0);
      const promoPostId = String(promoPayload.postId || "");
      const promoContentURI = String(promoPayload.contentURI || "");
      const promoRewardTokenAddress = String(promoPayload.rewardTokenAddress || "");
      const promoRewardTokenSymbol = String(promoPayload.rewardTokenSymbol || "ARENA");
      const promoArenaUserId = String(promoPayload.arenaUserId || "");
      const promoRequestTabId = sender.tab?.id;

      if (!promoContextId) {
        sendResponse({ success: false, error: "Missing promotion context." });
        return false;
      }
      if (pendingCreatePromotionApprovals.has(promoContextId)) {
        sendResponse({
          success: false,
          error: "A promotion approval is already pending.",
        });
        return false;
      }
      if (!promoSlots || promoSlots <= 0) {
        sendResponse({ success: false, error: "Invalid slots count." });
        return false;
      }
      if (!promoAmount || promoAmount < 100) {
        sendResponse({ success: false, error: "Minimum amount is 100 ARENA." });
        return false;
      }

      const taskLabels: Record<number, string> = {
        0: "Comment",
        1: "Repost",
        2: "Quote",
      };
      const taskLabel = taskLabels[promoType] || "Unknown";
      const promoDescription = `${taskLabel} promotion (${promoSlots} slot${promoSlots > 1 ? 's' : ''})`;

      const promoApprovalResponseHandler = (payload: any) => {
        if (!payload?.success) {
          const pendingEntry = pendingCreatePromotionApprovals.get(promoContextId);
          const targetTabId = pendingEntry?.tabId ?? promoRequestTabId;
          pendingCreatePromotionApprovals.delete(promoContextId);
          notifyCreatePromotionApprovalDenied(
            promoContextId,
            targetTabId,
            payload?.error || "Wallet approval was rejected."
          );
        }
      };

      const promoQueueId = walletActions.enqueue(
        {
          title: "Create Promotion",
          description: promoDescription,
          amount: promoAmount.toString(),
          tokenSymbol: promoRewardTokenSymbol,
        },
        async () => {
          const pending = pendingCreatePromotionApprovals.get(promoContextId);
          if (!pending) {
            notifyCreatePromotionApprovalDenied(
              promoContextId,
              promoRequestTabId,
              "Promotion request expired."
            );
            return { success: false, error: "Promotion request expired." };
          }
          pending.approved = true;
          notifyCreatePromotionApprovalGranted(promoContextId, pending.tabId ?? promoRequestTabId);
          return { success: true };
        },
        promoApprovalResponseHandler
      );

      pendingCreatePromotionApprovals.set(promoContextId, {
        promotionType: promoType,
        slots: promoSlots,
        amount: promoAmount,
        minFollowers: promoMinFollowers,
        expiresOn: promoExpiresOn,
        postId: promoPostId,
        contentURI: promoContentURI,
        rewardTokenAddress: promoRewardTokenAddress,
        rewardTokenSymbol: promoRewardTokenSymbol,
        arenaUserId: promoArenaUserId,
        queueId: promoQueueId,
        approved: false,
        tabId: promoRequestTabId,
      });

      sendResponse({ success: true });
      return false;

    case "CANCEL_CREATE_PROMOTION_APPROVAL":
      const promoContextId_cancel = String(message.contextId || message.payload?.contextId || "");
      if (!promoContextId_cancel) {
        sendResponse({ success: false, error: "Missing promotion context." });
        return false;
      }
      const promoPending_cancel = pendingCreatePromotionApprovals.get(promoContextId_cancel);
      if (!promoPending_cancel) {
        sendResponse({ success: false, error: "No pending promotion approval to cancel." });
        return false;
      }
      const promoReason =
        message.reason || message.payload?.reason || "Promotion cancelled.";
      if (!promoPending_cancel.approved && promoPending_cancel.queueId) {
        walletActions.cancelById(promoPending_cancel.queueId, promoReason);
      }
      pendingCreatePromotionApprovals.delete(promoContextId_cancel);
      sendResponse({ success: true });
      return false;

    case "QUEUE_TIP_SHOWER":
      const payload_queue = message.payload || {};
      if (payload_queue.useExistingApprovalContext) {
        const contextId_queue = String(payload_queue.contextId || "");
        const pending_queue = pendingTipShowerApprovals.get(contextId_queue);
        if (!pending_queue) {
          sendResponse({
            success: false,
            error: "No pending wallet approval found.",
          });
          return false;
        }
        if (!pending_queue.approved) {
          sendResponse({
            success: false,
            error: "Wallet approval is still pending.",
          });
          return false;
        }

        const recipients: TipShowerRecipient[] = Array.isArray(payload_queue.recipients)
          ? payload_queue.recipients
            .filter((item: any) => item && item.handle && item.address)
            .map((item: any) => ({
              handle: String(item.handle),
              address: String(item.address),
            }))
          : [];

        if (!recipients.length) {
          pendingTipShowerApprovals.delete(contextId_queue);
          notifyTipShowerApprovalDenied(
            contextId_queue,
            pending_queue.tabId,
            "No recipients provided."
          );
          sendResponse({ success: false, error: "No recipients provided." });
          return false;
        }

        (async () => {
          try {
            const result = await executeTipShowerBatch({
              recipients,
              amountPerTip: pending_queue.amountPerTip,
              tokenSymbol: pending_queue.tokenSymbol,
              tokenAddress: pending_queue.tokenAddress,
              contextId: contextId_queue,
              tabId: pending_queue.tabId,
            });
            pendingTipShowerApprovals.delete(contextId_queue);
            sendResponse(result);
          } catch (err: any) {
            pendingTipShowerApprovals.delete(contextId_queue);
            notifyTipShowerApprovalDenied(
              contextId_queue,
              pending_queue.tabId,
              err?.message || "Tip shower failed."
            );
            sendResponse({
              success: false,
              error: err?.message || "Tip shower failed.",
            });
          }
        })();

        return true;
      }

      const recipients: TipShowerRecipient[] = Array.isArray(payload_queue.recipients)
        ? payload_queue.recipients
          .filter((item: any) => item && item.handle && item.address)
          .map((item: any) => ({
            handle: String(item.handle),
            address: String(item.address),
          }))
        : [];

      if (!recipients.length) {
        sendResponse({ success: false, error: "No recipients provided." });
        return false;
      }

      (async () => {
        try {
          const result = await executeTipShowerBatch({
            recipients,
            amountPerTip: String(payload_queue.amountPerTip || payload_queue.amount || ""),
            tokenSymbol: payload_queue.tokenSymbol,
            tokenAddress: payload_queue.tokenAddress,
            contextId: payload_queue.contextId,
            tabId: sender.tab?.id,
          });
          sendResponse(result);
        } catch (err: any) {
          sendResponse({
            success: false,
            error: err?.message || "Tip shower failed.",
          });
        }
      })();

      return true;

    case "TIP_SHOWER_BATCH": {
      const payload = message.payload;
      const recipients: TipShowerRecipient[] = Array.isArray(payload.recipients)
        ? payload.recipients
          .filter((item: any) => item && item.handle && item.address)
          .map((item: any) => ({
            handle: String(item.handle),
            address: String(item.address),
          }))
        : [];
      if (!recipients.length) {
        sendResponse({ success: false, error: "No recipients provided." });
        return false;
      }
      const amountPerTip = String(payload.amountPerTip ?? payload.amount ?? "");
      if (!amountPerTip || Number(amountPerTip) <= 0) {
        sendResponse({
          success: false,
          error: "Invalid tip amount.",
        });
        return false;
      }
      const tokenSymbol = (payload.tokenSymbol || "PLUS").toUpperCase();
      const tokenAddress = payload.tokenAddress;
      const contextId = payload.contextId;
      const description =
        recipients.length === 1
          ? "Tip 1 post"
          : `Tip ${recipients.length} posts`;
      walletActions.enqueue(
        {
          title: "Tip Shower",
          description,
          amount: `${amountPerTip} x ${recipients.length}`,
          tokenSymbol,
        },
        () =>
          executeTipShowerBatch({
            recipients,
            amountPerTip,
            tokenSymbol,
            tokenAddress,
            contextId,
            tabId: sender.tab?.id,
          }),
        sendResponse
      );
      return true;
    }

    case "UPLOAD_GROVE_JSON":
      (async () => {
        // Helper fallback: data URI if Grove upload fails
        const toDataUri = (obj: any) => {
          const json = JSON.stringify(obj ?? {}, null, 2);
          const base64 = btoa(unescape(encodeURIComponent(json)));
          return `data:application/json;base64,${base64}`;
        };

        try {
          // Initialize client per call to avoid stale context
          const storageClient = StorageClient.create();
          // Use immutable ACL on testnet by default (adjust to mainnet if needed)
          const acl = immutable(chains.testnet.id);
          // Upload the payload directly as JSON metadata
          const result: any = await storageClient.uploadAsJson(
            message.payload || {},
            { acl }
          );
          // result typically includes { uri, gatewayUrl, storageKey }
          sendResponse({
            success: true,
            uri: result.uri,
            gatewayUrl: result.gatewayUrl,
            storageKey: result.storageKey,
          });
        } catch (e: any) {
          // Fallback to data URI to keep UX unblocked
          const uri = toDataUri(message.payload);
          sendResponse({
            success: true,
            uri,
            warning: e?.message || String(e),
          });
        }
      })();
      return true;

    case "FETCH_TEXT":
      (async () => {
        try {
          const url = message.url as string;
          if (url.startsWith("data:")) {
            const payload = url.split(",")[1] || "";
            const isBase64 = /;base64,/.test(url);
            try {
              let text: string;
              if (isBase64) {
                const binary = atob(payload);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                  bytes[i] = binary.charCodeAt(i);
                }
                const textDecoder = new TextDecoder("utf-8");
                text = textDecoder.decode(bytes);
              } else {
                try {
                  text = decodeURIComponent(payload);
                } catch (uriError) {
                  text = payload;
                }
              }
              sendResponse({ success: true, text });
            } catch (decodeError: any) {
              logBackground("Failed to decode data URI", decodeError);
              sendResponse({
                success: false,
                error: decodeError?.message || "Failed to decode data URI",
              });
            }
            return;
          }
          if (url.startsWith("lens://")) {
            const key = url.replace("lens://", "");
            const gw = `${import.meta.env.VITE_GROVE_API_URL || "https://api.grove.storage"}/${key}`;
            const res = await fetch(gw);
            if (!res.ok) {
              sendResponse({ success: false, error: `HTTP ${res.status}` });
              return;
            }
            const text = await res.text();
            sendResponse({ success: true, text });
            return;
          }
          const res = await fetch(url);
          if (!res.ok) {
            sendResponse({ success: false, error: `HTTP ${res.status}` });
            return;
          }
          const text = await res.text();
          sendResponse({ success: true, text });
        } catch (err: any) {
          sendResponse({ success: false, error: err?.message || String(err) });
        }
      })();
      return true;

    case "CREATE_PROMOTION":
      const createPromoPayload = message.payload || {};
      const createPromoContextId = String(createPromoPayload.contextId || "");

      // Check if using approval context
      if (createPromoContextId) {
        const pendingPromo = pendingCreatePromotionApprovals.get(createPromoContextId);
        if (pendingPromo) {
          if (!pendingPromo.approved) {
            sendResponse({
              success: false,
              error: "Wallet approval is still pending.",
            });
            return false;
          }
          // Use approved promotion data
          const approvedPayload = {
            promotionType: pendingPromo.promotionType,
            slots: pendingPromo.slots,
            amount: pendingPromo.amount,
            minFollowers: pendingPromo.minFollowers,
            expiresOn: pendingPromo.expiresOn,
            postId: pendingPromo.postId,
            contentURI: pendingPromo.contentURI,
            rewardTokenAddress: pendingPromo.rewardTokenAddress,
            arenaUserId: pendingPromo.arenaUserId,
            ...createPromoPayload, // Allow override if needed
          };
          pendingCreatePromotionApprovals.delete(createPromoContextId);
          executeCreatePromotion(approvedPayload).then(sendResponse);
          return true;
        }
      }

      // Fall back to direct execution (legacy support)
      executeCreatePromotion(message.payload).then(sendResponse);
      return true;

    case "CANCEL_PROMOTION":
      (async () => {
        try {
          if (cancelPromotionInFlight) {
            sendResponse({
              success: false,
              error: "Another cancellation is already in progress.",
            });
            return;
          }
          if (!isUnlocked || !inMemoryWallet || !inMemoryWallet.provider) {
            sendResponse({
              success: false,
              error: "Wallet is locked. Please unlock your wallet first.",
            });
            return;
          }
          const promotionIdRaw = message.payload?.promotionId;
          const promotionId = Number(promotionIdRaw);
          if (!Number.isFinite(promotionId) || promotionId < 0) {
            sendResponse({
              success: false,
              error: "Invalid promotion id.",
            });
            return;
          }

          cancelPromotionInFlight = true;
          const signer = new ethers.Wallet(
            inMemoryWallet.privateKey,
            inMemoryWallet.provider
          );
          let contract: any;
          try {
            contract = getPost2EarnContract(signer);
          } catch (e: any) {
            sendResponse({
              success: false,
              error: e?.message || "Invalid Post2Earn contract address.",
            });
            return;
          }

          const tx = await contract.cancelPromotion(promotionId);
          const receipt = await tx.wait();
          sendResponse({
            success: true,
            txHash: tx.hash,
            blockNumber: receipt?.blockNumber,
          });
        } catch (err: any) {
          logBackground("CANCEL_PROMOTION error:", err);
          sendResponse({
            success: false,
            error: err?.message || String(err),
          });
        } finally {
          cancelPromotionInFlight = false;
        }
      })();
      return true;

    case "FETCH_PROMOTIONS":
      (async () => {
        try {
          const provider =
            inMemoryWallet?.provider || new ethers.JsonRpcProvider(AVALANCHE_RPC);
          let contract: any;
          try {
            contract = getPost2EarnContract(provider);
          } catch (e: any) {
            sendResponse({
              success: false,
              error: e?.message || "Invalid Post2Earn contract address.",
            });
            return;
          }

          const countRaw = await contract.promotionCount();
          const promotionCountNum =
            typeof countRaw === "bigint" ? Number(countRaw) : Number(countRaw);
          if (!Number.isFinite(promotionCountNum) || promotionCountNum < 0) {
            sendResponse({ success: false, error: "Invalid promotion count" });
            return;
          }

          const indices = Array.from({ length: promotionCountNum }, (_, i) => i);
          const data = await Promise.all(
            indices.map(async (i) => {
              try {
                const [p, engagementsCountRaw] = await Promise.all([
                  contract.promotions(i),
                  contract.getEngagementsCount(i),
                ]);
                const engagementsCount =
                  typeof engagementsCountRaw === "bigint"
                    ? Number(engagementsCountRaw)
                    : Number(engagementsCountRaw);

                // Normalize tuple into a plain object and ensure bigints are serializable
                const normalized = {
                  id: i,
                  promoter: p.promoter,
                  promotionType: Number(
                    (p.promotionType as any)?.toString?.() ??
                    (p.promotionType as any)
                  ),
                  slotsAvailable: Number((p.slotsAvailable as any) ?? 0),
                  slotsTaken: Number((p.slotsTaken as any) ?? 0),
                  vaultAmount:
                    (p.vaultAmount as any)?.toString?.() ?? String(p.vaultAmount),
                  rewardPerSlot:
                    (p.rewardPerSlot as any)?.toString?.() ??
                    String(p.rewardPerSlot),
                  minFollowers: Number((p.minFollowers as any) ?? 0),
                  expiresOn: Number((p.expiresOn as any) ?? 0),
                  postId: p.postId,
                  contentURI: p.contentURI,
                  contentHash:
                    (p.contentHash as any)?.toString?.() ?? String(p.contentHash),
                  rewardToken: p.rewardToken || p[11],
                  active: Boolean(p.active),
                  engagementsCount,
                  _debug_rewardToken: p.rewardToken, // Debug field
                  likesMandatory: (() => {
                    // Parse likesMandatory from contentURI if it's base64-encoded JSON
                    if (p.contentURI && typeof p.contentURI === "string" && p.contentURI.startsWith("data:application/json;base64,")) {
                      try {
                        const base64 = p.contentURI.split(",")[1];
                        const json = atob(base64);
                        const metadata = JSON.parse(json);
                        return Boolean(metadata.likesMandatory);
                      } catch {
                        return false;
                      }
                    }
                    return false;
                  })(),
                };
                return normalized;
              } catch (e) {
                logBackground(
                  `FETCH_PROMOTIONS: Failed to fetch details for id=${i}`,
                  e
                );
                return { id: i, error: String(e) };
              }
            })
          );

          logBackground("FETCH_PROMOTIONS: Result", data);
          sendResponse({ success: true, data });
        } catch (err: any) {
          logBackground("FETCH_PROMOTIONS error:", err);
          sendResponse({ success: false, error: err?.message || String(err) });
        }
      })();

      return true;

    case "FETCH_MY_PROMOTIONS":
      (async () => {
        try {
          const userAddress = message.payload?.address;
          if (!userAddress || !ethers.isAddress(userAddress)) {
            sendResponse({
              success: false,
              error: "Valid wallet address is required.",
            });
            return;
          }

          const provider =
            inMemoryWallet?.provider || new ethers.JsonRpcProvider(AVALANCHE_RPC);
          let contract: any;
          try {
            contract = getPost2EarnContract(provider);
          } catch (e: any) {
            sendResponse({
              success: false,
              error: e?.message || "Invalid Post2Earn contract address.",
            });
            return;
          }

          const rawOptions = message.payload?.options || {};
          const offset = BigInt(Math.max(0, Number(rawOptions.offset ?? 0)));
          const limitNum = Number(rawOptions.limit ?? 20);
          const limit = BigInt(limitNum > 0 ? limitNum : 20);
          const newestFirst = rawOptions.newestFirst ?? true;
          const filterKey = (rawOptions.filter as string) || "all";
          const filterMap: Record<string, number> = {
            all: 0,
            cancelAvailable: 1,
            expiredWithUnusedVault: 2,
            vaultClaimed: 3,
          };
          const filterValue =
            filterMap[filterKey] ?? filterMap.all;

          const promotionIds =
            (await contract.getPromoterCreatedPromotions(
              userAddress,
              offset,
              limit,
              Boolean(newestFirst),
              filterValue
            )) || [];

          const data = await Promise.all(
            promotionIds.map(async (rawId: bigint, index: number) => {
              try {
                const id =
                  typeof rawId === "bigint" ? Number(rawId) : Number(rawId);
                if (!Number.isFinite(id)) {
                  throw new Error(`Invalid promotion id at index ${index}`);
                }
                const [details, engagementsCountRaw] = await Promise.all([
                  contract.promotions(rawId),
                  contract.getEngagementsCount(rawId),
                ]);
                const engagementsCount =
                  typeof engagementsCountRaw === "bigint"
                    ? Number(engagementsCountRaw)
                    : Number(engagementsCountRaw);

                return {
                  id,
                  promoter: details.promoter,
                  promotionType: Number(
                    (details.promotionType as any)?.toString?.() ??
                    (details.promotionType as any)
                  ),
                  slotsAvailable: Number((details.slotsAvailable as any) ?? 0),
                  slotsTaken: Number((details.slotsTaken as any) ?? 0),
                  vaultAmount:
                    (details.vaultAmount as any)?.toString?.() ??
                    String(details.vaultAmount),
                  rewardPerSlot:
                    (details.rewardPerSlot as any)?.toString?.() ??
                    String(details.rewardPerSlot),
                  minFollowers: Number((details.minFollowers as any) ?? 0),
                  expiresOn: Number((details.expiresOn as any) ?? 0),
                  postId: details.postId,
                  contentURI: details.contentURI,
                  contentHash:
                    (details.contentHash as any)?.toString?.() ??
                    String(details.contentHash),
                  rewardToken: details.rewardToken,
                  active: Boolean(details.active),
                  engagementsCount,
                  likesMandatory: (() => {
                    // Parse likesMandatory from contentURI if it's base64-encoded JSON
                    if (details.contentURI && typeof details.contentURI === "string" && details.contentURI.startsWith("data:application/json;base64,")) {
                      try {
                        const base64 = details.contentURI.split(",")[1];
                        const json = atob(base64);
                        const metadata = JSON.parse(json);
                        return Boolean(metadata.likesMandatory);
                      } catch {
                        return false;
                      }
                    }
                    return false;
                  })(),
                };
              } catch (err) {
                logBackground(
                  `FETCH_MY_PROMOTIONS: Failed to fetch promotion with rawId=${rawId}`,
                  err
                );
                return null;
              }
            })
          );

          sendResponse({
            success: true,
            data: data.filter(Boolean),
          });
        } catch (err: any) {
          logBackground("FETCH_MY_PROMOTIONS error:", err);
          sendResponse({
            success: false,
            error: err?.message || String(err),
          });
        }
      })();

      return true;

    case "GET_REWARD_TOKEN_METADATA":
      (async () => {
        try {
          const tokenAddress = message.payload?.tokenAddress;
          if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
            sendResponse({
              success: false,
              error: "Valid token address is required.",
            });
            return;
          }

          const provider =
            inMemoryWallet?.provider || new ethers.JsonRpcProvider(AVALANCHE_RPC);
          const data = await fetchErc20Metadata(provider, tokenAddress);

          sendResponse({
            success: true,
            data,
          });
        } catch (err: any) {
          logBackground("GET_REWARD_TOKEN_METADATA error:", err);
          sendResponse({
            success: true,
            data: null,
          });
        }
      })();

      return true;

    case "GET_ACTIVE_SUBSCRIBED_TOKENS":
      (async () => {
        try {
          const provider =
            inMemoryWallet?.provider || new ethers.JsonRpcProvider(AVALANCHE_RPC);
          let contract: any;
          try {
            contract = getPost2EarnContract(provider);
          } catch (e: any) {
            sendResponse({
              success: false,
              error: e?.message || "Invalid Post2Earn contract address.",
            });
            return;
          }

          // Call getActiveSubscriptions() which returns [tokens[], expirations[], subscribers[]]
          const result = await contract.getActiveSubscriptions();
          const [tokens, expirations, subscribers] = result;

          const now = Math.floor(Date.now() / 1000);
          const uniqueTokens = new Map<string, any>();

          for (let i = 0; i < tokens.length; i++) {
            const tokenAddress = tokens[i];
            if (!tokenAddress || tokenAddress === ethers.ZeroAddress) continue;

            const ttlSeconds = Number(expirations[i] ?? 0n);
            if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) continue;

            const expiresAt = now + ttlSeconds;
            const normalized = tokenAddress.toLowerCase();

            const entry = {
              tokenAddress,
              subscriber: subscribers[i],
              expiresAt,
            };

            const existing = uniqueTokens.get(normalized);
            if (!existing || expiresAt > existing.expiresAt) {
              uniqueTokens.set(normalized, entry);
            }
          }

          const finalTokens = Array.from(uniqueTokens.values());

          // Fetch metadata for each token
          await Promise.all(
            finalTokens.map(async (token) => {
              try {
                const meta = await fetchErc20Metadata(provider, token.tokenAddress);
                if (!meta) return;
                if (meta.symbol) token.symbol = meta.symbol;
                if (meta.name) token.name = meta.name;
                if (meta.decimals != null) token.decimals = meta.decimals;
              } catch (err) {
                // Token metadata fetch failed, leave without metadata
                logBackground(`Failed to fetch metadata for ${token.tokenAddress}:`, err);
              }
            })
          );

          sendResponse({
            success: true,
            data: finalTokens,
          });
        } catch (err: any) {
          logBackground("GET_ACTIVE_SUBSCRIBED_TOKENS error:", err);
          sendResponse({
            success: false,
            error: err?.message || "Failed to fetch subscribed tokens",
          });
        }
      })();

      return true;

    case "ENGAGE_IN_PROMOTION":
      logBackground("ENGAGE_IN_PROMOTION message received:", message.payload);
      (async () => {
        logBackground("Checking engagement conditions...");
        logBackground("isUnlocked:", isUnlocked);
        logBackground("inMemoryWallet:", !!inMemoryWallet);
        logBackground("twitterUser:", !!twitterUser);
        logBackground("engageInPromotionInFlight:", engageInPromotionInFlight);

        if (!isUnlocked || !inMemoryWallet || !inMemoryWallet.provider) {
          logBackground("Wallet is locked, returning error");
          return sendResponse({ success: false, error: "Wallet is locked." });
        }
        if (!twitterUser) {
          logBackground("User not logged in, returning error");
          return sendResponse({ success: false, error: "User not logged in." });
        }
        if (engageInPromotionInFlight) {
          logBackground("Another engagement in progress, returning error");
          return sendResponse({
            success: false,
            error: "Another engagement is in progress.",
          });
        }

        engageInPromotionInFlight = true;
        try {
          const {
            promotionId,
            engagementPostId,
            promotionPostId,
            engagementType,
            content: contentFromFrontend,
          } = message.payload;
          const signer = new ethers.Wallet(
            inMemoryWallet.privateKey,
            inMemoryWallet.provider
          );

          logBackground("Starting engagement process...");
          logBackground("promotionId:", promotionId);
          logBackground("engagementPostId:", engagementPostId);
          logBackground("promotionPostId:", promotionPostId);
          logBackground("inMemoryWallet address:", inMemoryWallet?.address);
          logBackground("signer address:", signer.address);

          const twitterUsername = twitterUser.user_metadata?.user_name || "";
          const loggedInUsername = twitterUser.user_metadata?.user_name || "";
          logBackground("twitterUsername:", twitterUsername);
          logBackground("loggedInUsername:", loggedInUsername);

          // Prefer followerCount from frontend payload; fallback to API if missing
          let followerCount = Number(message.payload?.followerCount ?? NaN);
          if (Number.isNaN(followerCount)) {
            logBackground(
              "Frontend did not provide followerCount; using safe fallback."
            );
            followerCount = 100; // fallback
          } else {
            logBackground(
              "Using followerCount provided by frontend:",
              followerCount
            );
          }

          // Generate signature for engagement
          let post2EarnCA: string;
          try {
            post2EarnCA = getPost2EarnAddressOrThrow();
          } catch (e: any) {
            throw new Error(e?.message || "Invalid Post2Earn contract address.");
          }

          // Read promotion details to enforce minFollowers
          const provider =
            inMemoryWallet?.provider || new ethers.JsonRpcProvider(AVALANCHE_RPC);
          const readContract = getPost2EarnContract(provider);
          const promoDetails = await readContract.getPromotionDetails(
            Number(promotionId)
          );
          const minFollowersRequired = Number(
            (promoDetails?.minFollowers as any) ?? 0
          );
          if (minFollowersRequired > 0 && followerCount < minFollowersRequired) {
            const msg = `Insufficient followers. Required: ${minFollowersRequired}, Actual: ${followerCount}`;
            logBackground("ENGAGE_IN_PROMOTION blocked:", msg);
            sendResponse({ success: false, error: msg });
            return; // Do not proceed to backend
          }

          // Create hash manually to match contract's _hash function
          const engagementTypeHash = ethers.keccak256(
            ethers.toUtf8Bytes(
              "Engagement(uint256 promotionId,string twitterUsername,string engagementPostId,uint256 followerCount,address engager)"
            )
          );

          const twitterUsernameHash = ethers.keccak256(
            ethers.toUtf8Bytes(twitterUsername)
          );
          const engagementPostIdHash = ethers.keccak256(
            ethers.toUtf8Bytes(engagementPostId)
          );

          logBackground("Hash components:");
          logBackground("- engagementTypeHash:", engagementTypeHash);
          logBackground("- promotionId:", promotionId);
          logBackground("- twitterUsernameHash:", twitterUsernameHash);
          logBackground("- engagementPostIdHash:", engagementPostIdHash);
          logBackground("- followerCount:", followerCount);
          logBackground("- engager:", signer.address);

          const structHash = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
              ["bytes32", "uint256", "bytes32", "bytes32", "uint256", "address"],
              [
                engagementTypeHash,
                promotionId,
                twitterUsernameHash,
                engagementPostIdHash,
                followerCount,
                signer.address,
              ]
            )
          );

          const domain = {
            name: "Post2Earn",
            version: "1",
            chainId: (await inMemoryWallet.provider.getNetwork()).chainId,
            verifyingContract: post2EarnCA,
          };

          const domainSeparator = ethers.TypedDataEncoder.hashDomain(domain);
          logBackground("Domain separator:", domainSeparator);
          logBackground("Struct hash:", structHash);

          const digest = ethers.keccak256(
            ethers.concat(["0x1901", domainSeparator, structHash])
          );

          logBackground("Final digest:", digest);
          // Sign the raw digest directly using the private key
          const signingKey = new ethers.SigningKey(inMemoryWallet.privateKey);
          const signature = signingKey.sign(digest).serialized;
          logBackground("Signature generated:", signature);

          // Resolve content for this promotion. If frontend provided content (including empty string), prefer that.
          let contentForEngagement: string =
            typeof contentFromFrontend === "string" ? contentFromFrontend : "";
          if (!contentForEngagement && engagementType !== "repost") {
            try {
              const promotionDetails = await readContract.getPromotionDetails(
                Number(promotionId)
              );
              const uri: string = promotionDetails.contentURI || "";
              if (uri) {
                if (uri.startsWith("data:")) {
                  const base64 = uri.split(",")[1] || "";
                  contentForEngagement = atob(base64);
                } else if (uri.startsWith("lens://")) {
                  const key = uri.replace("lens://", "");
                  const gw = `${import.meta.env.VITE_GROVE_API_URL || "https://api.grove.storage"}/${key}`;
                  const res = await fetch(gw);
                  if (res.ok) {
                    const text = await res.text();
                    try {
                      const j = JSON.parse(text);
                      contentForEngagement = j.content || text;
                    } catch {
                      contentForEngagement = text;
                    }
                  }
                } else {
                  const res = await fetch(uri);
                  if (res.ok) {
                    const text = await res.text();
                    try {
                      const j = JSON.parse(text);
                      contentForEngagement = j.content || text;
                    } catch {
                      contentForEngagement = text;
                    }
                  }
                }
              }
            } catch (e) {
              logBackground("Failed to resolve promotion content", e);
            }
          }

          // Call your backend API
          const backendApiUrl = import.meta.env.VITE_ENGAGE_API_URL || "http://paid4.daki.cc:4008/engage/iframe";
          const payload = {
            promotionId,
            twitterUsername,
            engagementPostId,
            followerCount,
            engager: signer.address,
            signature,
            loggedInUsername,
            promotionPostId,
            content: contentForEngagement,
            engagementType,
            arenaUserId: twitterUser.id,
          };

          logBackground("Calling backend API:", backendApiUrl);
          logBackground("Signer address:", signer.address);
          logBackground(
            "Full payload being sent:",
            JSON.stringify(payload, null, 2)
          );
          logBackground("=== FRONTEND SIGNATURE GENERATION VALUES ===");
          logBackground("promotionId used in signature:", promotionId);
          logBackground("twitterUsername used in signature:", twitterUsername);
          logBackground("engagementPostId used in signature:", engagementPostId);
          logBackground("followerCount used in signature:", followerCount);
          logBackground("engager used in signature:", signer.address);

          const apiResponse = await fetch(backendApiUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          });

          logBackground("Backend API response status:", apiResponse.status);
          logBackground(
            "Backend API response headers:",
            Object.fromEntries(apiResponse.headers.entries())
          );

          if (!apiResponse.ok) {
            const errorText = await apiResponse.text();
            logBackground("Backend API error response:", errorText);
            let errorResult;
            try {
              errorResult = JSON.parse(errorText);
            } catch {
              errorResult = { error: errorText };
            }
            throw new Error(errorResult.error || "Backend API error");
          }

          const result = await apiResponse.json();
          logBackground("Backend API success:", result);
          sendResponse({
            success: true,
            txHash: result.data?.contractTxHash || "backend-processed",
          });
        } catch (err: any) {
          logBackground("Engagement failed:", err);
          const reason =
            err?.reason ||
            err?.shortMessage ||
            err?.data?.message ||
            err?.error?.message ||
            err?.message ||
            "Engagement failed";
          sendResponse({ success: false, error: reason });

          // Handle nonce errors
          if (
            err?.code === "REPLACEMENT_UNDERPRICED" ||
            err?.code === "NONCE_EXPIRED" ||
            /nonce (too low|already used)/i.test(String(reason))
          ) {
            logBackground("Nonce error detected, re-syncing nonce...");
            try {
              const n = await new ethers.Wallet(
                inMemoryWallet!.privateKey,
                inMemoryWallet!.provider
              ).getNonce("latest");
              nonce = n;
              logBackground(`Nonce re-synced to ${nonce}`);
            } catch (e) {
              logBackground("Failed to re-sync nonce:", e);
            }
          }
        } finally {
          engageInPromotionInFlight = false;
        }
      })();
      return true;

    case "GET_BEARER_TOKEN":
      const respondWithToken = (token: string | null) => {
        if (token) {
          sendResponse({ token });
        } else {
          sendResponse({
            error:
              "Sync your Arena profile to interact with this feature. Open Arena Social, browse for a moment, then return here.",
          });
        }
      };

      try {
        chrome.cookies.get(
          { url: "https://arena.social", name: "token" },
          (cookie) => {
            if (chrome.runtime.lastError) {
              logBackground(
                "Failed to read Arena auth cookie:",
                chrome.runtime.lastError
              );
            }

            const raw = cookie?.value || "";
            if (raw) {
              const normalized = raw.startsWith("Bearer ")
                ? raw
                : `Bearer ${raw}`;
              respondWithToken(normalized);
              return;
            }

            respondWithToken(null);
          }
        );
      } catch (err) {
        logBackground("Error in GET_BEARER_TOKEN:", err);
        respondWithToken(null);
      }
      return true;

    case "GET_ARENA_USER_ID":
      try {
        chrome.cookies.get(
          { url: "https://arena.social", name: "user" },
          (cookie) => {
            if (chrome.runtime.lastError) {
              logBackground(
                "Failed to read Arena user cookie:",
                chrome.runtime.lastError
              );
              sendResponse({ userId: null });
              return;
            }

            if (cookie?.value) {
              try {
                const decodedCookie = decodeURIComponent(cookie.value);
                const parsed = JSON.parse(decodedCookie);
                if (parsed && parsed.id) {
                  sendResponse({ userId: parsed.id });
                  return;
                }
              } catch (e) {
                logBackground("Failed to parse user cookie JSON:", e);
              }
            }

            sendResponse({ userId: null });
          }
        );
      } catch (err) {
        logBackground("Error in GET_ARENA_USER_ID:", err);
        sendResponse({ userId: null });
      }
      return true;

    case "CHECK_WALLET_STATUS":
      sendResponse({
        isUnlocked: isUnlocked && !!inMemoryWallet,
        hasWallet: !!inMemoryWallet,
      });
      return false; // Synchronous response

    case "GET_WALLET_ACTION_QUEUE":
      sendResponse({ queue: walletActions.getSummary() });
      return false;

    case "RESPOND_WALLET_ACTION":
      sendResponse(walletActions.respond(message.id, Boolean(message.approved)));
      return false;

    case "PROMPT_UNLOCK_WALLET":
      (async () => {
        try {
          await walletActions.openPopup();
          sendResponse({ success: true });
        } catch (err: any) {
          logBackground("PROMPT_UNLOCK_WALLET error:", err);
          sendResponse({
            success: false,
            error: err?.message || String(err),
          });
        }
      })();
      return true;

    case "CHECK_LOGIN_STATUS":
      sendResponse({ isLoggedIn: !!twitterUser });
      return false; // Synchronous response

    case "SUBSCRIBE_TO_TOKEN":
      executeSubscribeToToken(message.payload).then(sendResponse);
      return true;

    default:
      // Unknown message type
      return false;
  }
});

// Function to fetch ARENA token price from DexScreener API
// Token monitoring functionality has been removed

logBackground("Background script loaded and ready");

export { };
