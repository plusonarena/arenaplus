import { TOKENS_MAP } from "../constants";
import { showToast } from "../utils/toast";

let isEnabled = false;
let tipAmount = "1";
let tipToken = "PLUS";

async function fetchAddress(handle: string): Promise<string | null> {
  try {
    console.log("[Cash Machine] Fetching address for handle:", handle);
    const res = await fetch(
      `https://api.starsarena.com/user/handle?handle=${encodeURIComponent(
        handle
      )}`
    );
    if (!res.ok) {
      console.error(
        "[Cash Machine] API request failed:",
        res.status,
        res.statusText
      );
      return null;
    }
    const data = await res.json();
    console.log("[Cash Machine] API response data:", data);
    if (!data?.user?.address) {
      console.warn(
        "[Cash Machine] Address not found in API response for handle:",
        handle
      );
    }
    return data?.user?.address || null;
  } catch (e) {
    console.error("[Cash Machine] Failed to fetch address", e);
    return null;
  }
}

function extractHandle(button: HTMLElement): string | null {
  console.log(
    "[Cash Machine] Attempting to extract handle from button:",
    button
  );
  const post = button.closest("div.cursor-pointer[class*='border-b']");

  if (!post) {
    console.log(
      "[Cash Machine] Could not find parent post element with the new selector."
    );
    return null;
  }

  // Look for the <a> element whose text starts with "@" (the username)
  const anchorEls = post.querySelectorAll("a.truncate");
  let handle: string | null = null;

  for (const el of Array.from(anchorEls)) {
    const text = el.textContent?.trim();
    if (text?.startsWith("@")) {
      handle = text.slice(1); // strip leading "@"
      break;
    }
  }

  if (!handle) {
    console.log(
      "[Cash Machine] Could not find username starting with @ in post."
    );
    return null;
  }

  console.log("[Cash Machine] Extracted handle:", handle);
  return handle;
}

async function handleLike(e: MouseEvent) {
  if ((window as any).isTipShowerActive) return;
  if (!isEnabled) return;
  const target = e.target as HTMLElement;
  const button = target.closest("button");
  if (!button) return;
  const svgPath = button.querySelector("svg path");
  if (!svgPath) return;
  if (!svgPath.getAttribute("d")?.startsWith("M352.92 80")) return;

  console.log("[Cash Machine] Like button clicked:", e.target);

  const handle = extractHandle(button);
  if (!handle) {
    console.log("[Cash Machine] Handle could not be extracted.");
    return;
  }

  const address = await fetchAddress(handle.toLowerCase());
  if (!address) {
    showToast("User address not found");
    console.log("[Cash Machine] Address not found for handle:", handle);
    return;
  }

  console.log(
    `[Cash Machine] Tipping ${tipAmount} ${tipToken} to ${handle} (${address})`
  );

  chrome.runtime.sendMessage(
    {
      type: "SEND_TIP",
      toAddress: address,
      amount: tipAmount,
      tokenAddress: TOKENS_MAP[tipToken].address,
      tokenSymbol: tipToken,
      source: "CASH_MACHINE",
      recipientHandle: handle,
    },
    (response) => {
      console.log("[Cash Machine] Response from background script:", response);
      if (response?.success) {
        showToast(`Sent ${tipAmount} ${tipToken} to ${handle}`);
      } else {
        if (response?.error === "INSUFFICIENT_BALANCE") {
          showToast(
            `${tipToken} balance exceeded your wallet balance. Please deposit to run cash machine.`
          );
        } else {
          showToast(`Tip failed: ${response?.error || "unknown"}`);
        }
        console.error("[Cash Machine] Tip failed:", response?.error);
      }
    }
  );
}

export function initCashMachine(
  initial: boolean,
  amount: string,
  token: string
) {
  isEnabled = initial;
  tipAmount = amount;
  tipToken = token;
  document.addEventListener("click", handleLike, true);
}

export function setCashMachine(
  enabled: boolean,
  amount: string,
  token?: string
) {
  isEnabled = enabled;
  tipAmount = amount;
  if (token) {
    tipToken = token;
  }
}
