/**
 * OKX DEX aggregator client.
 *
 * Zero dependencies. The official @okx-dex/okx-dex-sdk wraps exactly this, and on a hackathon
 * clock one less package that can break its own auth is worth more than the convenience.
 *
 * ---------------------------------------------------------------------------------------
 *  VERIFIED AGAINST THE LIVE DOCS ON 14 AUGUST 2026
 *
 *  The build spec this project started from described the v5 API, which required a
 *  project id sent as an OK-ACCESS-PROJECT header. That is no longer how it works:
 *
 *    - The aggregator is now on /api/v6/, not /api/v5/
 *    - The chain parameter is `chainIndex`, not `chainId`
 *    - There is NO OK-ACCESS-PROJECT header. Authentication is four headers:
 *      OK-ACCESS-KEY, OK-ACCESS-SIGN, OK-ACCESS-TIMESTAMP, OK-ACCESS-PASSPHRASE
 *
 *  Source: https://web3.okx.com/onchainos/dev-docs/home/api-access-and-usage
 *          https://web3.okx.com/onchainos/dev-docs/trade/dex-api-reference
 *
 *  A project id is still accepted if you set OKX_PROJECT_ID, purely for older deployments,
 *  but it is not required and not having one is not an error.
 * ---------------------------------------------------------------------------------------
 *
 * Auth: HMAC-SHA256 over `timestamp + method + requestPath + bodyOrQueryString`, base64
 * encoded. requestPath INCLUDES the query string. Getting that wrong is the most common
 * cause of a signature error, so `_sign` takes the already-assembled path and nothing else.
 */

const crypto = require("crypto");

const X_LAYER_MAINNET = 196;
const X_LAYER_TESTNET = 1952;

class OkxDexClient {
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.OKX_BASE_URL ?? "https://web3.okx.com";
    this.apiVersion = opts.apiVersion ?? process.env.OKX_API_VERSION ?? "v6";
    this.apiKey = opts.apiKey ?? process.env.OKX_API_KEY;
    this.secretKey = opts.secretKey ?? process.env.OKX_SECRET_KEY;
    this.passphrase = opts.passphrase ?? process.env.OKX_API_PASSPHRASE;
    // Optional. Only sent if present, for deployments still pinned to the old v5 behaviour.
    this.projectId = opts.projectId ?? process.env.OKX_PROJECT_ID ?? "";
    this.chainIndex = String(opts.chainId ?? opts.chainIndex ?? process.env.CHAIN_ID ?? X_LAYER_MAINNET);
    // Public endpoints rate limit; stay well inside it.
    this.minIntervalMs = opts.minIntervalMs ?? 120;
    this._lastCall = 0;
  }

  /** Three values are required. The project id is not one of them. */
  get configured() {
    return Boolean(this.apiKey && this.secretKey && this.passphrase);
  }

  get missing() {
    return [
      ["OKX_API_KEY", this.apiKey],
      ["OKX_SECRET_KEY", this.secretKey],
      ["OKX_API_PASSPHRASE", this.passphrase],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
  }

  _path(endpoint) {
    return `/api/${this.apiVersion}/dex/aggregator/${endpoint}`;
  }

  _sign(timestamp, method, requestPath, body = "") {
    const payload = `${timestamp}${method.toUpperCase()}${requestPath}${body}`;
    return crypto.createHmac("sha256", this.secretKey).update(payload).digest("base64");
  }

  async _request(method, path, params = {}, body = null) {
    if (!this.configured) {
      throw new Error(
        `OKX credentials missing: ${this.missing.join(", ")}. ` +
          `A project id is NOT required on the v6 API.`,
      );
    }

    const qs = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    const requestPath = qs ? `${path}?${qs}` : path;
    const bodyStr = body ? JSON.stringify(body) : "";
    const timestamp = new Date().toISOString();

    // Simple client-side spacing so a burst of quotes does not trip the limiter.
    const wait = this.minIntervalMs - (Date.now() - this._lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastCall = Date.now();

    const headers = {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": this.apiKey,
      "OK-ACCESS-SIGN": this._sign(timestamp, method, requestPath, bodyStr),
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.passphrase,
    };
    // Only sent when explicitly configured. v6 does not use it.
    if (this.projectId) headers["OK-ACCESS-PROJECT"] = this.projectId;

    let res;
    try {
      res = await fetch(this.baseUrl + requestPath, {
        method,
        headers,
        body: bodyStr || undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      // Node throws a bare "fetch failed" and hides the actual reason in `cause`. Without
      // unwrapping it you cannot tell a DNS failure from a blocked region from a TLS problem.
      const cause = err.cause || {};
      const detail = [cause.code, cause.errno, cause.message].filter(Boolean).join(" ") || err.message;
      throw new Error(
        `Could not reach ${this.baseUrl}. ${detail}. ` +
          `This is a network problem, not an API rejection: the request never got a response.`,
      );
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`OKX ${res.status} non-JSON response: ${text.slice(0, 200)}`);
    }
    // OKX returns HTTP 200 with a non-zero `code` on logical failures. Check both.
    if (!res.ok || (json.code !== undefined && String(json.code) !== "0")) {
      throw new Error(`OKX ${res.status} code=${json.code} msg=${json.msg ?? text.slice(0, 200)}`);
    }
    return json.data ?? json;
  }

  // -- Step 1: what chains are live -----------------------------------------
  getSupportedChains() {
    return this._request("GET", this._path("supported/chain"), { chainIndex: this.chainIndex });
  }

  // -- Step 2: what tokens are routable on X Layer --------------------------
  getTokens() {
    return this._request("GET", this._path("all-tokens"), { chainIndex: this.chainIndex });
  }

  getLiquiditySources() {
    return this._request("GET", this._path("get-liquidity"), { chainIndex: this.chainIndex });
  }

  // -- Step 3: price it -----------------------------------------------------
  /** @param amount base units of fromToken (not decimal-adjusted) */
  getQuote({ fromTokenAddress, toTokenAddress, amount }) {
    return this._request("GET", this._path("quote"), {
      chainIndex: this.chainIndex,
      fromTokenAddress,
      toTokenAddress,
      amount,
    });
  }

  // -- Step 4: approve ------------------------------------------------------
  getApproveTransaction({ tokenContractAddress, approveAmount }) {
    return this._request("GET", this._path("approve-transaction"), {
      chainIndex: this.chainIndex,
      tokenContractAddress,
      approveAmount,
    });
  }

  // -- Step 5: build the swap ----------------------------------------------
  getSwapTransaction({ fromTokenAddress, toTokenAddress, amount, userWalletAddress, slippage = "0.005" }) {
    return this._request("GET", this._path("swap"), {
      chainIndex: this.chainIndex,
      fromTokenAddress,
      toTokenAddress,
      amount,
      userWalletAddress,
      slippage,
    });
  }

  // -- Step 6: did it land --------------------------------------------------
  // Least verified of the six. The self test does not exercise it, so confirm the shape
  // against the live docs before relying on it in a demo.
  getTransactionStatus({ orderId, txHash }) {
    return this._request("GET", this._path("history"), {
      chainIndex: this.chainIndex,
      orderId,
      txHash,
      limit: 1,
    });
  }

  /**
   * Convenience: quote then swap, signing and broadcasting with an ethers wallet.
   * Set `dryRun` to walk the sequence and see what WOULD be sent. Use dry run the first
   * few times; a mis-signed swap on mainnet is an expensive way to learn.
   */
  async routeSwap({ wallet, fromTokenAddress, toTokenAddress, amount, slippage = "0.005", dryRun = true }) {
    const quote = await this.getQuote({ fromTokenAddress, toTokenAddress, amount });
    const swap = await this.getSwapTransaction({
      fromTokenAddress,
      toTokenAddress,
      amount,
      userWalletAddress: await wallet.getAddress(),
      slippage,
    });

    const txData = Array.isArray(swap) ? swap[0]?.tx : swap?.tx;
    if (!txData) throw new Error("OKX swap response had no tx payload. Check the shape against live docs.");

    if (dryRun) return { dryRun: true, quote, tx: txData };

    const sent = await wallet.sendTransaction({
      to: txData.to,
      data: txData.data,
      value: txData.value ?? 0n,
      gasLimit: txData.gas ? BigInt(txData.gas) : undefined,
    });
    const receipt = await sent.wait();
    return { dryRun: false, quote, txHash: receipt.hash, receipt };
  }
}

// `npm run okx:selftest` - run this the day your keys arrive, not the day before submission.
if (require.main === module && process.argv.includes("--selftest")) {
  (async () => {
    require("dotenv").config({ path: require("path").join(__dirname, "..", "..", "..", ".env") });
    const c = new OkxDexClient();

    console.log(`\n  base      ${c.baseUrl}`);
    console.log(`  version   ${c.apiVersion}`);
    console.log(`  chain     ${c.chainIndex}`);
    console.log(`  project   ${c.projectId ? "set (not required on v6)" : "not set (correct for v6)"}\n`);

    if (!c.configured) {
      console.error(`  Missing: ${c.missing.join(", ")}`);
      console.error(`  Fill these into .env. A project id is NOT required.\n`);
      process.exit(1);
    }

    // Reachability first. If the host is unreachable, every signed call fails identically and
    // the signature is not the problem, so it is worth separating the two before guessing.
    process.stdout.write("  connectivity check... ");
    try {
      const probe = await fetch(c.baseUrl, { method: "GET", signal: AbortSignal.timeout(15_000) });
      console.log(`reachable (HTTP ${probe.status})\n`);
    } catch (err) {
      const cause = err.cause || {};
      const detail = [cause.code, cause.errno, cause.message].filter(Boolean).join(" ") || err.message;
      console.log(`UNREACHABLE\n`);
      console.error(`  ${c.baseUrl} could not be contacted at all.`);
      console.error(`  Reason: ${detail}\n`);
      console.error(`  Common causes, in the order worth checking:`);
      console.error(`    1. No internet, or a VPN or firewall blocking the request`);
      console.error(`    2. OKX restricts DEX API access in some regions. A VPN in a supported`);
      console.error(`       region is the usual workaround, and their docs mention this limit.`);
      console.error(`    3. Corporate or ISP DNS filtering on the domain`);
      console.error(`\n  Quick manual check, run this in your terminal:`);
      console.error(`    curl -I ${c.baseUrl}\n`);
      process.exit(1);
    }

    let failures = 0;
    for (const [label, fn] of [
      ["supported chains", () => c.getSupportedChains()],
      ["tokens", () => c.getTokens()],
      ["liquidity sources", () => c.getLiquiditySources()],
    ]) {
      try {
        const d = await fn();
        console.log(`  ok    ${label}: ${Array.isArray(d) ? d.length + " entries" : "ok"}`);
      } catch (e) {
        failures++;
        console.log(`  FAIL  ${label}: ${e.message}`);
      }
    }

    if (failures) {
      console.log(`\n  ${failures} of 3 failed.`);
      console.log(`  code=50113 means the signature was rejected, usually a wrong passphrase.`);
      console.log(`  A 404 means an endpoint path moved again. Check the live docs.\n`);
      process.exit(1);
    }
    console.log(`\n  All three endpoints answered. OKX integration is live.\n`);
  })();
}

module.exports = { OkxDexClient, X_LAYER_MAINNET, X_LAYER_TESTNET };
