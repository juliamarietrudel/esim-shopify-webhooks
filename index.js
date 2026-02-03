import express from "express";
import crypto from "crypto";
import QRCode from "qrcode";
import { Resend } from "resend";

const app = express();

// -----------------------------
// Email (Resend)
// -----------------------------
const resendApiKey = (process.env.RESEND_API_KEY || "").trim();
const emailFrom = (process.env.EMAIL_FROM || "").trim();
const emailEnabled = Boolean(resendApiKey && emailFrom);
const resend = emailEnabled ? new Resend(resendApiKey) : null;

if (!emailEnabled) {
  console.warn(
    "⚠️ Email not configured. Set RESEND_API_KEY and EMAIL_FROM to send eSIM emails."
  );
}

async function generateQrPngBase64(payload) {
  if (!payload) return null;
  const pngBuffer = await QRCode.toBuffer(payload, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 1,
    scale: 6,
  });
  return pngBuffer.toString("base64");
}

function formatEsimEmailHtml({ firstName, activationCode, manualCode, smdpAddress, apn }) {
  const safeName = (firstName || "").trim() || "there";
  const safeApn = apn ? `<li><b>APN</b>: ${apn}</li>` : "";

  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial; line-height: 1.5;">
    <h2>Your eSIM is ready ✅</h2>
    <p>Hi ${safeName},</p>
    <p>To install your eSIM, scan the QR code attached to this email on your eSIM-compatible device.</p>

    <h3>Activation details (backup)</h3>
    <ul>
      <li><b>Activation code</b>: <code>${activationCode || ""}</code></li>
      <li><b>Manual code</b>: <code>${manualCode || ""}</code></li>
      <li><b>SM-DP+ address</b>: <code>${smdpAddress || ""}</code></li>
      ${safeApn}
    </ul>

    <p style="margin-top: 16px;">If you have any issues, reply to this email and we’ll help you.</p>
  </div>
  `;
}

async function sendEsimEmail({ to, firstName, orderId, activationCode, manualCode, smdpAddress, apn }) {
  if (!emailEnabled) {
    console.log("ℹ️ Skipping email send (email not configured).");
    return false;
  }
  if (!to) {
    console.warn("⚠️ No customer email found on order; cannot send eSIM email.");
    return false;
  }
  if (!activationCode) {
    console.warn("⚠️ Missing activation_code; cannot generate QR email.");
    return false;
  }

  const qrBase64 = await generateQrPngBase64(activationCode);
  if (!qrBase64) {
    console.warn("⚠️ Failed to generate QR code.");
    return false;
  }

  const subject = orderId
    ? `Your eSIM QR code (Order #${orderId})`
    : "Your eSIM QR code";

  const html = formatEsimEmailHtml({
    firstName,
    activationCode,
    manualCode,
    smdpAddress,
    apn,
  });

  const result = await resend.emails.send({
    from: emailFrom,
    to,
    subject,
    html,
    // Attach the QR as a PNG so it works across more email clients
    attachments: [
      {
        filename: "esim-qr.png",
        content: qrBase64,
      },
    ],
  });

  if (result?.error) {
    console.error("❌ Resend error:", result.error);
    return false;
  }

  console.log("✅ eSIM email sent via Resend:", { to, id: result?.data?.id });
  return true;
}

// TEMP idempotency for testing (resets on restart/deploy)
const processedOrders = new Set();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // Buffer (raw bytes)
    },
  })
);

app.get("/", (_req, res) => res.send("Webhook server running :)"));

// -----------------------------
// HTTP helpers (better errors + timeout)
// -----------------------------
async function safeFetch(url, options = {}) {
  const ctrl = new AbortController();
  const timeoutMs = Number(process.env.FETCH_TIMEOUT_MS || 15000);
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    // Node fetch often throws "fetch failed"; log the underlying cause if present
    console.error("❌ FETCH ERROR:", e?.message, "cause:", e?.cause);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function shopifyGraphqlUrl() {
  const shopRaw = process.env.SHOPIFY_SHOP_DOMAIN;
  const versionRaw = process.env.SHOPIFY_API_VERSION || "2025-01";

  const shop = (shopRaw || "").trim();
  const version = (versionRaw || "").trim();

  if (!shop) throw new Error("Missing SHOPIFY_SHOP_DOMAIN env var");
  if (!version) throw new Error("Missing SHOPIFY_API_VERSION env var");

  return `https://${shop}/admin/api/${version}/graphql.json`;
}

async function getMayaCustomerDetails(mayaCustomerId) {
  const baseUrl = process.env.MAYA_BASE_URL || "https://api.maya.net";

  const resp = await safeFetch(`${baseUrl}/connectivity/v1/customer/${mayaCustomerId}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: mayaAuthHeader(),
    },
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    console.error("❌ Maya get customer failed:", resp.status, data);
    throw new Error(`Maya get customer failed (${resp.status})`);
  }

  return data; // contient customer.esims[].plans[]
}

async function createMayaTopUp({ iccid, planTypeId, tag = "" }) {
  const baseUrl = process.env.MAYA_BASE_URL || "https://api.maya.net";

  const resp = await safeFetch(`${baseUrl}/connectivity/v1/esim/${iccid}/plan/${planTypeId}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: mayaAuthHeader(),
    },
    body: JSON.stringify(tag ? { tag } : {}), // certaines APIs acceptent tag, sinon c’est OK vide
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    console.error("❌ Maya top-up failed:", resp.status, data);
    throw new Error(`Maya top-up failed (${resp.status})`);
  }

  return data;
}


async function sendAdminAlertEmail({ subject, html }) {
  const to = (process.env.ALERT_EMAIL_TO || "").trim();
  if (!emailEnabled || !to) {
    console.warn("⚠️ Alert email not sent (missing RESEND config or ALERT_EMAIL_TO).");
    return false;
  }

  const result = await resend.emails.send({
    from: emailFrom,
    to,
    subject,
    html,
  });

  if (result?.error) {
    console.error("❌ Resend alert error:", result.error);
    return false;
  }
  return true;
}


// -----------------------------
// Shopify signature verification
// -----------------------------
function verifyShopifyWebhook(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
  const secret = process.env.WEBHOOK_API_KEY; // Shopify app API secret key

  if (!secret) {
    console.error("❌ Missing WEBHOOK_API_KEY env var on server");
    return false;
  }
  if (!hmacHeader) {
    console.error("❌ Missing X-Shopify-Hmac-Sha256 header");
    return false;
  }
  if (!req.rawBody) {
    console.error("❌ Missing req.rawBody (raw bytes not captured)");
    return false;
  }

  const computed = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, "base64"),
      Buffer.from(hmacHeader, "base64")
    );
  } catch (e) {
    console.error("❌ timingSafeEqual error:", e.message);
    return false;
  }
}

// --------------------------------------
// Shopify Admin API: read variant metafield
// --------------------------------------
async function getVariantConfig(variantId) {
  const token = process.env.API_ACCESS_TOKEN;
  const url = shopifyGraphqlUrl();
  if (!token) throw new Error("Missing API_ACCESS_TOKEN env var");

  const gid = `gid://shopify/ProductVariant/${variantId}`;

  const query = `
    query ($id: ID!) {
      productVariant(id: $id) {
        id
        title

        mayaPlanId: metafield(namespace: "custom", key: "maya_plan_id") { value }
        productType: metafield(namespace: "custom", key: "type_de_produit") { value }
      }
    }
  `;

  const resp = await safeFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables: { id: gid } }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok || json.errors) {
    console.error("❌ Shopify GraphQL error:", json.errors || json);
    throw new Error(`Shopify GraphQL failed (${resp.status})`);
  }

  const v = json?.data?.productVariant;
  const mayaPlanId = (v?.mayaPlanId?.value || "").trim() || null;
  const productType = (v?.productType?.value || "").trim().toLowerCase() || null;

  return { mayaPlanId, productType };
}

// Backwards-compat helper (older code paths may still call this)
// Returns the Maya plan_type_id stored on the variant.
async function getMayaPlanIdForVariant(variantId) {
  const cfg = await getVariantConfig(variantId);
  return cfg?.mayaPlanId || null;
}

// -----------------------------
// Maya: Basic Auth header
// -----------------------------
function mayaAuthHeader() {
  const auth = process.env.MAYA_AUTH; // base64(username:password)
  if (!auth) throw new Error("Missing MAYA_AUTH env var");
  return `Basic ${auth}`;
}

async function saveMayaCustomerIdToShopifyCustomer(shopifyCustomerId, mayaCustomerId) {
  const token = process.env.API_ACCESS_TOKEN;
  const url = shopifyGraphqlUrl();

  if (!token) throw new Error("Missing API_ACCESS_TOKEN env var");

  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key value }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: gid,
        namespace: "custom",
        key: "maya_customer_id",
        type: "single_line_text_field",
        value: String(mayaCustomerId),
      },
    ],
  };

  const resp = await safeFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query: mutation, variables }),
  });

  const json = await resp.json().catch(() => ({}));

  const userErrors = json?.data?.metafieldsSet?.userErrors || [];
  if (!resp.ok || json.errors || userErrors.length) {
    console.error("❌ Shopify metafield write error:", {
      status: resp.status,
      errors: json.errors,
      userErrors,
      response: json,
    });
    throw new Error(userErrors[0]?.message || "Failed to write Shopify customer metafield");
  }

  return true;
}

async function getMayaCustomerIdFromShopifyCustomer(shopifyCustomerId) {
  const token = process.env.API_ACCESS_TOKEN;
  const url = shopifyGraphqlUrl();

  console.log("🔎 GraphQL URL:", url);

  if (!token) throw new Error("Missing API_ACCESS_TOKEN env var");

  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;

  const query = `
    query ($id: ID!) {
      customer(id: $id) {
        id
        metafield(namespace: "custom", key: "maya_customer_id") {
          value
        }
      }
    }
  `;

  const resp = await safeFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables: { id: gid } }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok || json.errors) {
    console.error("❌ Shopify customer metafield read error:", json.errors || json);
    throw new Error(`Shopify GraphQL failed (${resp.status})`);
  }

  return json?.data?.customer?.metafield?.value || null; // string or null
}

// -----------------------------
// Maya: Create customer
// POST https://api.maya.net/connectivity/v1/customer/
// -----------------------------
async function createMayaCustomer({ email, firstName, lastName, countryIso2, tag = "" }) {
  const baseUrl = process.env.MAYA_BASE_URL || "https://api.maya.net";

  const body = {
    email,
    first_name: firstName || "",
    last_name: lastName || "",
    country: countryIso2 || "US",
  };

  if (tag) body.tag = tag;

  const resp = await safeFetch(`${baseUrl}/connectivity/v1/customer/`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: mayaAuthHeader(),
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    console.error("❌ Maya create customer failed:", resp.status, data);
    throw new Error(`Maya create customer failed (${resp.status})`);
  }

  // Depending on the API, the created customer may be in data.customer or similar.
  // We'll try both safe paths:
  const customerId = data?.customer?.id || data?.customer?.uid || data?.id || null;

  if (!customerId) {
    console.error("❌ Could not find customer id in Maya response:", data);
    throw new Error("Maya customer created but no customer id returned");
  }

  return { raw: data, customerId };
}

// -----------------------------
// Maya: Create eSIM + data plan attached to customer
// POST https://api.maya.net/connectivity/v1/esim
// -----------------------------
async function createMayaEsim({ planTypeId, customerId, tag = "" }) {
  const baseUrl = process.env.MAYA_BASE_URL || "https://api.maya.net";

  const body = {
    plan_type_id: planTypeId,
    customer_id: customerId,
  };

  if (tag) body.tag = tag;

  const resp = await safeFetch(`${baseUrl}/connectivity/v1/esim`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: mayaAuthHeader(),
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    console.error("❌ Maya create eSIM failed:", resp.status, data);
    throw new Error(`Maya create eSIM failed (${resp.status})`);
  }

  return data;
}

// -----------------------------
// Helpers: get buyer info from order
// -----------------------------
function pickBuyerFromOrder(order) {
  const email = order?.email || order?.contact_email || "";

  const firstName =
    order?.customer?.first_name ||
    order?.billing_address?.first_name ||
    order?.shipping_address?.first_name ||
    "";

  const lastName =
    order?.customer?.last_name ||
    order?.billing_address?.last_name ||
    order?.shipping_address?.last_name ||
    "";

  // Shopify gives country_code as ISO2 (CA/US/etc.) in addresses
  const countryIso2 =
    order?.billing_address?.country_code ||
    order?.shipping_address?.country_code ||
    "US";

  return { email, firstName, lastName, countryIso2 };
}

// -----------------------------
// Webhook: orders/paid
// -----------------------------
app.post("/webhooks/order-paid", async (req, res) => {
  const ok = verifyShopifyWebhook(req);

  console.log("---- WEBHOOK DEBUG START ----");
  console.log("Topic:", req.get("X-Shopify-Topic"));
  console.log("Shop:", req.get("X-Shopify-Shop-Domain"));
  console.log("Content-Type:", req.get("content-type"));
  console.log("Raw body length:", req.rawBody?.length);
  console.log("HMAC MATCH:", ok);
  console.log("---- WEBHOOK DEBUG END ----");

  if (!ok) return res.status(401).send("Invalid signature");

  const order = req.body || {};
  const orderId = order?.id;
  const { email, firstName, lastName, countryIso2 } = pickBuyerFromOrder(order);

  console.log("Order ID:", orderId);
  console.log("Buyer:", { email, firstName, lastName, countryIso2 });
  console.log("order.customer_id:", order?.customer_id);
  console.log("order.customer?.id:", order?.customer?.id);
  console.log("order.customer:", order?.customer);

  // TEMP idempotency: avoid double provisioning if Shopify retries
  if (orderId && processedOrders.has(orderId)) {
    console.log("🔁 Duplicate webhook ignored for order:", orderId);
    return res.status(200).send("OK");
  }
  if (orderId) processedOrders.add(orderId);

  // 1) Get or create Maya customer id (reuse Shopify metafield if present)
  let mayaCustomerId = null;

  const shopifyCustomerId = order?.customer?.id || order?.customer_id || null;
  console.log("Shopify customer id on order:", shopifyCustomerId);

  if (shopifyCustomerId) {
  try {
      const existing = await getMayaCustomerIdFromShopifyCustomer(shopifyCustomerId);
      const existingTrimmed = (existing || "").trim();

      if (existingTrimmed) {
        mayaCustomerId = existingTrimmed;
        console.log("✅ Reusing Maya customer id from Shopify metafield:", mayaCustomerId);
      } else {
        console.log("ℹ️ Shopify metafield maya_customer_id is empty (will create Maya customer).");
      }
    } catch (e) {
      console.error("❌ Could not read Shopify customer metafield:", e.message);
    }
  }

  // If not found, create Maya customer + save it to Shopify metafield
  if (!mayaCustomerId) {
    try {
      const created = await createMayaCustomer({
        email,
        firstName,
        lastName,
        countryIso2,
        tag: String(orderId || ""),
      });
      mayaCustomerId = created.customerId;
      console.log("✅ Maya customer created:", mayaCustomerId);

      if (shopifyCustomerId) {
        try {
          await saveMayaCustomerIdToShopifyCustomer(shopifyCustomerId, mayaCustomerId);
          console.log("✅ Saved Maya customer id to Shopify customer metafield:", {
            shopifyCustomerId,
            mayaCustomerId,
          });
        } catch (e) {
          console.error("❌ Failed saving Maya customer id to Shopify:", e.message);
        }
      } else {
        console.warn("⚠️ No Shopify customer on order, can't persist Maya ID (guest checkout).");
      }
    } catch (e) {
      console.error("❌ Maya customer creation failed:", e.message);
      return res.status(200).send("OK");
    }
  }

  // 2) Create eSIM(s) attached to that customer
  const items = order?.line_items || [];
  console.log("🧾 LINE ITEMS:", items.length);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const variantId = String(item.variant_id);
    const qty = Number(item.quantity || 1);

    let mayaPlanId = null;
    let productType = null;
    try {
      const cfg = await getVariantConfig(variantId);
      mayaPlanId = cfg?.mayaPlanId || null;
      productType = cfg?.productType || null;
    } catch (e) {
      console.error("❌ Failed to fetch metafield for variant:", variantId, e.message);
    }

    console.log(`Item #${i + 1}:`, {
      title: item.title,
      variant_title: item.variant_title,
      variant_id: variantId,
      quantity: qty,
      maya_plan_id: mayaPlanId,
    });

    if (!mayaPlanId) {
      console.error("❌ Missing metafield custom.maya_plan_id for variant:", variantId);
      continue;
    }

    // -----------------------------
    // RECHARGE (TOP UP)
    // -----------------------------
    if (productType === "recharge") {
      // Must already have a Maya customer id to find existing eSIMs
      if (!mayaCustomerId) {
        await sendAdminAlertEmail({
          subject: `⚠️ Top-up received but no Maya customer id (Order #${orderId || ""})`,
          html: `
            <p>Order contains a <b>top-up</b>, but we could not resolve a Maya customer id.</p>
            <ul>
              <li><b>Order ID</b>: ${orderId || ""}</li>
              <li><b>Email</b>: ${email || ""}</li>
              <li><b>Variant ID</b>: ${variantId}</li>
              <li><b>Maya plan_type_id</b>: ${mayaPlanId}</li>
            </ul>
            <p>No action was taken. Please contact the customer.</p>
          `,
        });
        continue;
      }

      let mayaDetails = null;
      try {
        mayaDetails = await getMayaCustomerDetails(mayaCustomerId);
      } catch (e) {
        await sendAdminAlertEmail({
          subject: `⚠️ Top-up failed: could not fetch Maya customer (Order #${orderId || ""})`,
          html: `
            <p>Order contains a <b>top-up</b>, but fetching the Maya customer failed.</p>
            <ul>
              <li><b>Order ID</b>: ${orderId || ""}</li>
              <li><b>Email</b>: ${email || ""}</li>
              <li><b>Maya customer id</b>: ${mayaCustomerId}</li>
              <li><b>Variant ID</b>: ${variantId}</li>
              <li><b>Maya plan_type_id</b>: ${mayaPlanId}</li>
              <li><b>Error</b>: ${(e && e.message) || e}</li>
            </ul>
            <p>No action was taken.</p>
          `,
        });
        continue;
      }

      const customer = mayaDetails?.customer;
      const esims = Array.isArray(customer?.esims) ? customer.esims : [];

      // Your rule: only consider ACTIVE eSIMs
      const activeEsims = esims.filter((e) => String(e?.service_status || "").toLowerCase() === "active");

      // Choose the eSIM whose matching plan (same plan_type.id) has the LOWEST remaining bytes.
      // Secondary tiebreaks: prefer a plan that has been activated; then earliest start_time.
      function isActivated_(plan) {
        const da = String(plan?.date_activated || "");
        return da && da !== "0000-00-00 00:00:00";
      }

      function toInt_(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n : NaN;
      }

      function timeValue_(s) {
        const t = Date.parse(String(s || ""));
        return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
      }

      let best = null; // { iccid, esimUid, planId, bytesRemaining, activated, startTime }

      for (const e of activeEsims) {
        const plans = Array.isArray(e?.plans) ? e.plans : [];
        for (const p of plans) {
          const planTypeId = p?.plan_type?.id;
          if (!planTypeId) continue;
          if (String(planTypeId) !== String(mayaPlanId)) continue;

          const bytesRemaining = toInt_(p?.data_bytes_remaining);
          const activated = isActivated_(p);
          const startTime = p?.start_time;

          const candidate = {
            iccid: e?.iccid,
            esimUid: e?.uid,
            planId: p?.id,
            bytesRemaining: Number.isFinite(bytesRemaining) ? bytesRemaining : Number.POSITIVE_INFINITY,
            activated,
            startTime,
          };

          if (!best) {
            best = candidate;
            continue;
          }

          // 1) lowest remaining bytes wins
          if (candidate.bytesRemaining < best.bytesRemaining) {
            best = candidate;
            continue;
          }
          if (candidate.bytesRemaining > best.bytesRemaining) continue;

          // 2) prefer activated plan
          if (candidate.activated && !best.activated) {
            best = candidate;
            continue;
          }
          if (!candidate.activated && best.activated) continue;

          // 3) earliest start_time
          if (timeValue_(candidate.startTime) < timeValue_(best.startTime)) {
            best = candidate;
            continue;
          }
        }
      }

      if (!best?.iccid) {
        await sendAdminAlertEmail({
          subject: `⚠️ Top-up received but no matching ACTIVE eSIM found (Order #${orderId || ""})`,
          html: `
            <p>Order contains a <b>top-up</b>, but we couldn't find an ACTIVE eSIM with an existing plan matching this plan_type_id.</p>
            <ul>
              <li><b>Order ID</b>: ${orderId || ""}</li>
              <li><b>Email</b>: ${email || ""}</li>
              <li><b>Maya customer id</b>: ${mayaCustomerId}</li>
              <li><b>Variant ID</b>: ${variantId}</li>
              <li><b>Maya plan_type_id</b>: ${mayaPlanId}</li>
            </ul>
            <p>No action was taken. Please contact the customer.</p>
          `,
        });
        continue;
      }

      console.log("🔁 Top-up target chosen:", {
        iccid: best.iccid,
        esim_uid: best.esimUid,
        matched_plan_id: best.planId,
        bytes_remaining: best.bytesRemaining,
        activated: best.activated,
        start_time: best.startTime,
        plan_type_id: mayaPlanId,
      });

      // Apply the top-up qty times (creates NEW plans on the same eSIM)
      for (let q = 0; q < qty; q++) {
        try {
          const topupResp = await createMayaTopUp({
            iccid: best.iccid,
            planTypeId: mayaPlanId,
            tag: String(orderId || ""),
          });

          console.log("✅ Maya top-up created:", {
            iccid: best.iccid,
            plan_type_id: mayaPlanId,
            new_plan_id: topupResp?.plan?.id,
            request_id: topupResp?.request_id,
          });
        } catch (e) {
          console.error("❌ Maya top-up error:", e.message);
          await sendAdminAlertEmail({
            subject: `❌ Top-up failed in Maya (Order #${orderId || ""})`,
            html: `
              <p>Creating a Maya top-up failed.</p>
              <ul>
                <li><b>Order ID</b>: ${orderId || ""}</li>
                <li><b>Email</b>: ${email || ""}</li>
                <li><b>Maya customer id</b>: ${mayaCustomerId}</li>
                <li><b>ICCID</b>: ${best.iccid}</li>
                <li><b>plan_type_id</b>: ${mayaPlanId}</li>
                <li><b>Error</b>: ${(e && e.message) || e}</li>
              </ul>
            `,
          });
        }
      }

      // Done with this line item (do NOT create a new eSIM)
      continue;
    }

    for (let q = 0; q < qty; q++) {
      try {
        const mayaResp = await createMayaEsim({
          planTypeId: mayaPlanId,
          customerId: mayaCustomerId,
          tag: String(orderId || ""), // traceability
        });

        console.log("✅ Maya eSIM created (attached to customer):", {
          maya_customer_id: mayaCustomerId,
          maya_esim_uid: mayaResp?.esim?.uid,
          iccid: mayaResp?.esim?.iccid,
          activation_code: mayaResp?.esim?.activation_code,
          manual_code: mayaResp?.esim?.manual_code,
          smdp_address: mayaResp?.esim?.smdp_address,
          apn: mayaResp?.esim?.apn,
        });

        // 3) Email QR code to customer (Resend)
        try {
          await sendEsimEmail({
            to: email,
            firstName,
            orderId,
            activationCode: mayaResp?.esim?.activation_code,
            manualCode: mayaResp?.esim?.manual_code,
            smdpAddress: mayaResp?.esim?.smdp_address,
            apn: mayaResp?.esim?.apn,
          });
        } catch (e) {
          console.error("❌ Failed to send eSIM email:", e?.message || e);
        }
      } catch (e) {
        console.error("❌ Maya provisioning error:", e.message);
      }
    }
  }

  return res.status(200).send("OK");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));