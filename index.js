// index.js
import express from "express";
import crypto from "crypto";
import QRCode from "qrcode";
import { Resend } from "resend";
import "dotenv/config";

// import { safeFetch } from "./utils/http.js"; // (unused right now) you can remove

import {
  getVariantConfig,
  getOrderProcessedFlag,
  markOrderProcessed,
  getMayaCustomerIdFromShopifyCustomer,
  saveMayaCustomerIdToShopifyCustomer,
  saveEsimToOrder,
  getOrdersWithEsims,
} from "./services/shopify.js";

import {
  createMayaCustomer,
  createMayaEsim,
  getMayaCustomerDetails,
  createMayaTopUp,
  getMayaEsimDetailsByIccid,
  getMayaEsimPlansByIccid,
} from "./services/maya.js";

const app = express();

// -----------------------------
// Usage alert settings (CRON)
// -----------------------------
const USAGE_ALERT_THRESHOLD_PERCENT = Number(process.env.USAGE_ALERT_THRESHOLD_PERCENT || 20);
// In-memory de-dupe so we don't email every cron run while the server stays up.
// NOTE: if the server restarts, this resets. For true "send once" you should persist a flag in Shopify metafields.
const usageAlertSentKeys = new Set();

// -----------------------------
// Email (Resend)
// -----------------------------
const resendApiKey = (process.env.RESEND_API_KEY || "").trim();
const emailFrom = (process.env.EMAIL_FROM || "").trim();
const emailEnabled = Boolean(resendApiKey && emailFrom);
const resend = emailEnabled ? new Resend(resendApiKey) : null;

if (!emailEnabled) {
  console.warn("⚠️ Email not configured. Set RESEND_API_KEY and EMAIL_FROM to send eSIM emails.");
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

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatEsimEmailHtml({
  firstName,
  planName,
  country,
  validityDays,
  dataQuotaMb,
  iccid,
  activationCode,
  manualCode,
  smdpAddress,
  apn,
  qrDataUrl,
}) {
  const safeName = (firstName || "").trim() || "there";

  const row = (label, value) =>
    value
      ? `<tr><td style="padding:10px 0;"><b>${label}:</b> ${esc(value)}</td></tr>`
      : "";

  const codeRow = (label, value) =>
    value
      ? `<tr>
          <td style="padding:10px 0;">
            <b>${label}:</b>
            <code style="background:#F1F5F9; padding:4px 8px; border-radius:6px;">
              ${esc(value)}
            </code>
          </td>
        </tr>`
      : "";

  const apnRow = apn ? `<tr><td style="padding:10px 0;"><b>APN:</b> ${esc(apn)}</td></tr>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Your eSIM is ready</title>
</head>

<body style="margin:0; padding:0; background:#F6FAFD; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial;">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding: 32px 0;">
    <tr>
      <td align="center">

        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
          style="width:100%; max-width:800px; background:#FFFFFF; border-radius: 18px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); overflow:hidden;">

          <tr>
            <td style="padding: 20px 24px; border-bottom: 1px solid #E5E7EB;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <img 
                      src="https://quebecesim.ca/cdn/shop/files/1000008019.png?v=1737480349&width=600"
                      alt="Québec eSIM"
                      width="80"
                      style="display:block; max-width:140px; height:auto;"
                    />
                  </td>
                  <td align="right">
                    <span style="display:inline-block; padding:8px 12px; border-radius:999px; background:#0CA3EC; color:#FFFFFF; font-weight:600; font-size:12px;">
                      eSIM
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding: 28px 24px;">

              <h1 style="margin: 0 0 16px; font-size: 22px; color:#0F172A;">
                Your eSIM is ready!
              </h1>

              <p style="font-size: 15px; color:#334155; margin: 0 0 20px;">
                Hi <b>${esc(safeName)}</b>,
              </p>

              <p style="font-size: 15px; color:#334155; margin: 0 0 28px;">
                Your eSIM for <b style="color:#0CA3EC;">${esc(planName || "your plan")}</b> is now ready.
                Scan the QR code attached to install it on your device.
              </p>

              <div style="height: 16px;"></div>

              <h2 style="font-size: 16px; color:#0F172A; margin: 0 0 12px;">Plan details</h2>

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#FFFFFF; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px; margin-bottom: 28px;">
                ${row("Plan", planName)}
                ${row("Destination", country)}
                ${row("Validity", validityDays ? `${validityDays} days` : "")}
                ${row("Data", dataQuotaMb ? `${dataQuotaMb} MB` : "")}
                ${codeRow("ICCID", iccid)}
              </table>

              <div style="text-align:center; margin: 20px 0 28px;">
                <img 
                    src="${qrDataUrl}"
                    alt="Scan to install eSIM"
                    width="180"
                    style="border-radius:12px; border:1px solid #E5E7EB;"
                />
                <p style="font-size:12px; color:#64748B; margin-top:8px;">
                    Scan this QR code to install your eSIM
                </p>
              </div>

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#F8FAFC; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px; margin: 12px 0 28px;">
                <tr>
                  <td style="font-size: 13px; color:#475569;">
                    <b>Tip:</b> If you’re using the same phone, open this email on another device to scan the QR code.
                  </td>
                </tr>
              </table>

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#FFFFFF; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px;">
                ${codeRow("Activation code", activationCode)}
                ${codeRow("Manual code", manualCode)}
                ${codeRow("SM-DP+ address", smdpAddress)}
                ${apnRow}
              </table>

            </td>
          </tr>

          <tr>
            <td style="padding: 18px 24px; background:#F8FAFC; border-top: 1px solid #E5E7EB; font-size: 12px; color:#64748B;">
              <b>Need help?</b>
              <a href="https://quebecesim.ca/pages/contactez-nous" style="text-decoration:none; color: rgb(94, 94, 94);">
                Contactez-nous
              </a><br/>
              © 2026 Québec E-Sim • Powered by Maya
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;
}

async function sendEsimEmail({
  to,
  firstName,
  orderId,
  activationCode,
  manualCode,
  smdpAddress,
  apn,
  planName,
  country,
  validityDays,
  dataQuotaMb,
  iccid,
}) {
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
  const qrDataUrl = `data:image/png;base64,${qrBase64}`;

  const subject = orderId ? `Your eSIM QR code (Order #${orderId})` : "Your eSIM QR code";

  const html = formatEsimEmailHtml({
    firstName,
    planName,
    country,
    validityDays,
    dataQuotaMb,
    iccid,
    activationCode,
    manualCode,
    smdpAddress,
    apn,
    qrDataUrl,
  });

  const result = await resend.emails.send({
    from: emailFrom,
    to,
    subject,
    html,
    attachments: [{ filename: "esim-qr.png", content: qrBase64 }],
  });

  if (result?.error) {
    console.error("❌ Resend error:", result.error);
    return false;
  }

  console.log("✅ eSIM email sent via Resend:", { to, id: result?.data?.id });
  return true;
}

async function sendUsageAlertEmail({
  to,
  firstName,
  orderId,
  percentUsed,
  thresholdPercent,
  iccid,
  planId,
}) {
  if (!emailEnabled) {
    console.log("ℹ️ Skipping usage alert email (email not configured).");
    return false;
  }
  if (!to) {
    console.warn("⚠️ No recipient email; cannot send usage alert email.");
    return false;
  }

  const safeName = (firstName || "").trim() || "there";
  const subject = orderId
    ? `Data usage alert (Order #${orderId})`
    : "Data usage alert";

  const html = `
    <div style="margin:0; padding:0; background:#F6FAFD; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial; color:#0F172A;">
      <div style="max-width:640px; margin:0 auto; padding:24px;">
        <div style="background:#FFFFFF; border:1px solid #E5E7EB; border-radius:16px; padding:22px;">
          <h2 style="margin:0 0 12px; font-size:18px;">Hi ${esc(safeName)} 👋</h2>
          <p style="margin:0 0 12px; font-size:14px; color:#334155;">
            You’ve used more than <b>${thresholdPercent}%</b> of your data.
          </p>
          <p style="margin:0 0 12px; font-size:14px; color:#334155;">
            Current usage: <b>${percentUsed}%</b>
          </p>
          ${iccid ? `<p style="margin:0 0 6px; font-size:12px; color:#64748B;"><b>ICCID</b>: ${esc(iccid)}</p>` : ""}
          ${planId ? `<p style="margin:0 0 6px; font-size:12px; color:#64748B;"><b>Plan ID</b>: ${esc(planId)}</p>` : ""}
          <p style="margin:14px 0 0; font-size:12px; color:#64748B;">
            Need more data? You can purchase a top-up anytime.
          </p>
        </div>
      </div>
    </div>
  `;

  const result = await resend.emails.send({
    from: emailFrom,
    to,
    subject,
    html,
  });

  if (result?.error) {
    console.error("❌ Resend usage alert error:", result.error);
    return false;
  }

  console.log("✅ Usage alert email sent via Resend:", { to, id: result?.data?.id });
  return true;
}

async function sendAdminAlertEmail({ subject, html }) {
  const to = (process.env.ALERT_EMAIL_TO || "").trim();
  if (!emailEnabled || !to) {
    console.warn("⚠️ Alert email not sent (missing RESEND config or ALERT_EMAIL_TO).");
    return false;
  }

  const result = await resend.emails.send({ from: emailFrom, to, subject, html });

  if (result?.error) {
    console.error("❌ Resend alert error:", result.error);
    return false;
  }
  return true;
}

// -----------------------------
// Middleware: JSON + raw body capture (for HMAC)
// -----------------------------
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // Buffer (raw bytes)
    },
  })
);

app.get("/", (_req, res) => res.send("Webhook server running :)"));

// -----------------------------
// CRON (protected endpoint)
// -----------------------------
app.get("/cron/check-usage", async (req, res) => {
  const secret = (process.env.CRON_SECRET || "").trim();
  const token = String(req.query.token || "").trim();

  if (!secret) {
    console.error("❌ Missing CRON_SECRET env var");
    return res.status(500).send("Server not configured");
  }

  if (!token || token !== secret) {
    return res.status(401).send("Unauthorized");
  }

  console.log("🕒 CRON check-usage triggered:", new Date().toISOString());

  try {
    const orders = await getOrdersWithEsims({ daysBack: 365 });
    console.log("✅ Orders with eSIMs found:", orders.length);

    for (const o of orders) {
      const { orderId, iccid, email, firstName } = o;
      console.log(`\n🔎 Checking usage for order ${orderId} — ICCID: ${iccid}`);
      console.log("🔎 ABOUT TO FETCH ICCID:", iccid);

      let esim = null;
      try {
        esim = await getMayaEsimDetailsByIccid(iccid);
      } catch (e) {
        console.warn(`⚠️ Maya lookup failed for ICCID ${iccid}:`, e?.message || e);
        continue; // keep checking the other orders
      }
      if (!esim) {
        console.warn(`⚠️ No eSIM found in Maya for ICCID ${iccid}`);
        continue;
      }
      console.log("🧩 esim keys:", Object.keys(esim || {}));
      console.log("🧩 esim.plans exists?", Array.isArray(esim?.plans), "length:", esim?.plans?.length);

      if (esim?.plans?.length) {
        console.log("🧩 first plan keys:", Object.keys(esim.plans[0] || {}));
        console.log("🧩 first plan sample:", esim.plans[0]);
      }

      // optional: sometimes the payload is nested
      if (esim?.esim) {
        console.log("🧩 esim.esim keys:", Object.keys(esim.esim || {}));
        console.log("🧩 esim.esim.plans length:", esim?.esim?.plans?.length);
      }

      let plans = [];
      try {
        plans = await getMayaEsimPlansByIccid(iccid);
      } catch (e) {
        console.warn(`⚠️ Maya plans lookup failed for ICCID ${iccid}:`, e?.message || e);
        continue;
      }

      console.log("📦 Plans found:", plans.length);

      console.log(
        "🧾 plans snapshot:",
        plans.map((p) => ({
          id: p.id,
          quota: p.data_quota_bytes,
          remaining: p.data_bytes_remaining,
          activated: p.date_activated,
          start: p.start_time,
          end: p.end_time,
          net: p.network_status,
        }))
      );

      // Optional: per-plan debug output
      for (const p of plans) {
        const pTotalBytes = Number(p.data_quota_bytes || 0);
        const pRemainingBytes = Number(p.data_bytes_remaining || 0);
        const pUsedBytes = pTotalBytes - pRemainingBytes;
        const pPercentUsed = pTotalBytes > 0 ? Math.round((pUsedBytes / pTotalBytes) * 100) : null;

        console.log("📊 plan usage", {
          orderId,
          iccid,
          planId: p.id,
          totalBytes: pTotalBytes,
          remainingBytes: pRemainingBytes,
          percentUsed: pPercentUsed === null ? "n/a" : `${pPercentUsed}%`,
          activated: p.date_activated,
          net: p.network_status,
          start: p.start_time,
          end: p.end_time,
        });
      }

      // Pick the plan we consider the "current" one for alerting
      const activePlan = pickCurrentPlan(plans);

      if (!activePlan) {
        console.warn(`⚠️ No plans attached to ICCID ${iccid}`);
        continue;
      }

      const totalBytes = Number(activePlan.data_quota_bytes || 0);
      const remainingBytes = Number(activePlan.data_bytes_remaining || 0);

      if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
        console.warn(`⚠️ Invalid data quota for ICCID ${iccid}`);
        continue;
      }

      const usedBytes = totalBytes - remainingBytes;
      const percentUsed = Math.round((usedBytes / totalBytes) * 100);

      console.log({
        orderId,
        iccid,
        activePlanId: activePlan.id,
        totalBytes,
        remainingBytes,
        percentUsed: `${percentUsed}%`,
        activated: activePlan.date_activated,
        net: activePlan.network_status,
        start: activePlan.start_time,
        end: activePlan.end_time,
      });

      // -----------------------------
      // Usage alert (send once per server lifetime)
      // -----------------------------
      const threshold = Number.isFinite(USAGE_ALERT_THRESHOLD_PERCENT)
        ? USAGE_ALERT_THRESHOLD_PERCENT
        : 20;

      if (Number.isFinite(percentUsed) && percentUsed >= threshold) {
        const dedupeKey = `${orderId}:${iccid}:${threshold}`;

        if (usageAlertSentKeys.has(dedupeKey)) {
          console.log(`ℹ️ Usage alert already sent for ${dedupeKey}, skipping.`);
        } else {
          if (!email) {
            console.warn(
              `⚠️ Usage alert triggered (${percentUsed}%) but order is missing email. ` +
                `Update getOrdersWithEsims() to return { email, firstName } for order ${orderId}.`
            );
          } else {
            try {
              await sendUsageAlertEmail({
                to: email,
                firstName,
                orderId,
                percentUsed,
                thresholdPercent: threshold,
                iccid,
                planId: activePlan?.id,
              });
              usageAlertSentKeys.add(dedupeKey);
            } catch (e) {
              console.error("❌ Failed to send usage alert email:", e?.message || e);
            }
          }
        }
      }
    }

    return res.status(200).json({ ok: true, count: orders.length });
  } catch (e) {
    console.error("❌ Cron check-usage failed:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// -----------------------------
// Small helpers
// -----------------------------
function normId(x) {
  return String(x || "").trim().toLowerCase();
}

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

  const countryIso2 =
    order?.billing_address?.country_code ||
    order?.shipping_address?.country_code ||
    "US";

  return { email, firstName, lastName, countryIso2 };
}

function pickCurrentPlan(plans) {
  if (!Array.isArray(plans) || plans.length === 0) return null;

  const isActivated = (p) => {
    const da = String(p?.date_activated || "");
    return da && da !== "0000-00-00 00:00:00";
  };

  const isActiveNet = (p) => {
    const ns = String(p?.network_status || "").toUpperCase();
    // Maya examples you've seen: ACTIVE / NOT_ACTIVE
    return ns === "ACTIVE" || ns === "ENABLED";
  };

  const withRemaining = (arr) =>
    arr.filter((p) => Number(p?.data_bytes_remaining || 0) > 0);

  // Priority pools (highest to lowest)
  const pools = [
    // Activated + network ACTIVE first
    withRemaining(plans.filter((p) => isActivated(p) && isActiveNet(p))),
    // Activated (even if network status isn't ACTIVE)
    withRemaining(plans.filter((p) => isActivated(p))),
    // Anything with remaining data
    withRemaining(plans),
    // Fallback: any plan
    plans,
  ];

  const pool = pools.find((p) => p.length > 0) || plans;

  // newest start_time wins
  const sorted = [...pool].sort((a, b) => {
    const ta = Date.parse(String(a?.start_time || "")) || 0;
    const tb = Date.parse(String(b?.start_time || "")) || 0;
    return tb - ta;
  });

  return sorted[0] || null;
}

// -----------------------------
// Shopify signature verification
// -----------------------------
function verifyShopifyWebhook(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
  const secret = process.env.WEBHOOK_API_KEY;

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

  const computed = crypto.createHmac("sha256", secret).update(req.rawBody).digest("base64");

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

  if (!orderId) {
    console.warn("⚠️ No order id in payload, exiting.");
    return res.status(200).send("OK");
  }

  // ✅ IDEMPOTENCY (Order metafields)
  try {
    const flag = await getOrderProcessedFlag(orderId);
    if (flag?.processed) {
      console.log("🛑 Order already processed, skipping:", { orderId, processedAt: flag.processedAt });
      return res.status(200).send("OK");
    }
  } catch (e) {
    console.error("⚠️ Could not read order processed flag:", e?.message || e);
  }

  let shouldMarkProcessed = true;

  // 1) Get or create Maya customer id
  let mayaCustomerId = null;
  const shopifyCustomerId = order?.customer?.id || order?.customer_id || null;
  console.log("Shopify customer id on order:", shopifyCustomerId);

  if (shopifyCustomerId) {
    try {
      const existing = await getMayaCustomerIdFromShopifyCustomer(shopifyCustomerId);
      const existingTrimmed = (existing || "").trim();
      if (existingTrimmed) {
        mayaCustomerId = existingTrimmed;
        console.log("✅ Reusing Maya customer id from Shopify customer metafield:", mayaCustomerId);
      }
    } catch (e) {
      console.error("❌ Could not read Shopify customer metafield:", e.message);
    }
  }

  if (!mayaCustomerId) {
    try {
      const created = await createMayaCustomer({
        email,
        firstName,
        lastName,
        countryIso2,
        tag: String(orderId),
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
        console.warn("⚠️ No Shopify customer on order (guest checkout).");
      }
    } catch (e) {
      console.error("❌ Maya customer creation failed:", e.message);
      shouldMarkProcessed = false;
      return res.status(200).send("OK");
    }
  }

  // 2) Process line items
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
      console.error("❌ Failed to fetch config for variant:", variantId, e.message);
      shouldMarkProcessed = false;
      continue;
    }

    console.log(`Item #${i + 1}:`, {
      title: item.title,
      variant_title: item.variant_title,
      variant_id: variantId,
      quantity: qty,
      maya_plan_id: mayaPlanId,
      product_type: productType,
    });

    if (!mayaPlanId) {
      console.error("❌ Missing metafield custom.maya_plan_id for variant:", variantId);
      shouldMarkProcessed = false;
      continue;
    }

    // -----------------------------
    // RECHARGE (TOP UP)
    // -----------------------------
    if (productType === "recharge") {
      console.log("🔄 Entering TOP-UP flow", { orderId, variantId, qty, mayaPlanId, mayaCustomerId });

      if (!mayaCustomerId) {
        shouldMarkProcessed = false;
        await sendAdminAlertEmail({
          subject: `⚠️ Top-up received but no Maya customer id (Order #${orderId})`,
          html: `
            <p>Order contains a <b>top-up</b>, but we could not resolve a Maya customer id.</p>
            <ul>
              <li><b>Order ID</b>: ${orderId}</li>
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
        shouldMarkProcessed = false;
        await sendAdminAlertEmail({
          subject: `⚠️ Top-up failed: could not fetch Maya customer (Order #${orderId})`,
          html: `
            <p>Order contains a <b>top-up</b>, but fetching the Maya customer failed.</p>
            <ul>
              <li><b>Order ID</b>: ${orderId}</li>
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
      console.log("👤 Maya customer loaded", { mayaCustomerId, esims_count: esims.length });

      const candidateEsims = esims.filter((e) => {
        const state = String(e?.state || "").toLowerCase();
        const service = String(e?.service_status || "").toLowerCase();
        if (state.includes("terminated") || state.includes("cancel")) return false;
        if (service.includes("terminated") || service.includes("cancel")) return false;
        return true;
      });

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

      let best = null;

      for (const e of candidateEsims) {
        const plans = Array.isArray(e?.plans) ? e.plans : [];
        for (const p of plans) {
          const planTypeId = p?.plan_type?.id;
          if (!planTypeId) continue;
          if (normId(planTypeId) !== normId(mayaPlanId)) continue;

          const bytesRemaining = toInt_(p?.data_bytes_remaining);
          const activated = isActivated_(p);

          const candidate = {
            iccid: e?.iccid,
            esimUid: e?.uid,
            planId: p?.id,
            planTypeId,
            bytesRemaining: Number.isFinite(bytesRemaining) ? bytesRemaining : Number.POSITIVE_INFINITY,
            activated,
            startTime: p?.start_time,
          };

          if (!best) {
            best = candidate;
            continue;
          }

          if (candidate.bytesRemaining < best.bytesRemaining) {
            best = candidate;
            continue;
          }
          if (candidate.bytesRemaining > best.bytesRemaining) continue;

          if (candidate.activated && !best.activated) {
            best = candidate;
            continue;
          }
          if (!candidate.activated && best.activated) continue;

          if (timeValue_(candidate.startTime) < timeValue_(best.startTime)) {
            best = candidate;
            continue;
          }
        }
      }

      if (!best?.iccid) {
        shouldMarkProcessed = false;
        await sendAdminAlertEmail({
          subject: `⚠️ Top-up received but no matching eSIM found (Order #${orderId})`,
          html: `
            <p>Order contains a <b>top-up</b>, but we couldn't find any eSIM with an existing plan matching this plan_type_id.</p>
            <ul>
              <li><b>Order ID</b>: ${orderId}</li>
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
        plan_type_id_from_shopify: mayaPlanId,
        plan_type_id_from_maya: best.planTypeId,
      });

      for (let q = 0; q < qty; q++) {
        const topUpPlanTypeId = best.planTypeId || mayaPlanId;
        try {
          const topupResp = await createMayaTopUp({
            iccid: best.iccid,
            planTypeId: topUpPlanTypeId,
            tag: String(orderId),
          });

          console.log("✅ Maya top-up created:", {
            iccid: best.iccid,
            plan_type_id: topUpPlanTypeId,
            new_plan_id: topupResp?.plan?.id,
            request_id: topupResp?.request_id,
          });
        } catch (e) {
          shouldMarkProcessed = false;
          console.error("❌ Maya top-up error:", e.message);
          await sendAdminAlertEmail({
            subject: `❌ Top-up failed in Maya (Order #${orderId})`,
            html: `
              <p>Creating a Maya top-up failed.</p>
              <ul>
                <li><b>Order ID</b>: ${orderId}</li>
                <li><b>Email</b>: ${email || ""}</li>
                <li><b>Maya customer id</b>: ${mayaCustomerId}</li>
                <li><b>ICCID</b>: ${best.iccid}</li>
                <li><b>plan_type_id</b>: ${topUpPlanTypeId}</li>
                <li><b>Error</b>: ${(e && e.message) || e}</li>
              </ul>
            `,
          });
        }
      }

      continue;
    }

    // -----------------------------
    // NORMAL eSIM purchase: create eSIM(s)
    // -----------------------------
    for (let q = 0; q < qty; q++) {
      try {
        const mayaResp = await createMayaEsim({
          planTypeId: mayaPlanId,
          customerId: mayaCustomerId,
          tag: String(orderId),
        });

        console.log("✅ Maya eSIM created:", {
          maya_customer_id: mayaCustomerId,
          maya_esim_uid: mayaResp?.esim?.uid,
          iccid: mayaResp?.esim?.iccid,
          activation_code: mayaResp?.esim?.activation_code,
          manual_code: mayaResp?.esim?.manual_code,
          smdp_address: mayaResp?.esim?.smdp_address,
          apn: mayaResp?.esim?.apn,
        });

        try {
          await saveEsimToOrder(orderId, {
            iccid: mayaResp?.esim?.iccid,
            esimUid: mayaResp?.esim?.uid,
          });
          console.log("✅ Saved eSIM info to Shopify order:", {
            orderId,
            iccid: mayaResp?.esim?.iccid,
            esimUid: mayaResp?.esim?.uid,
          });
        } catch (e) {
          console.error("❌ Failed to save eSIM info to Shopify order:", e?.message || e);
          shouldMarkProcessed = false;
        }

        try {
          await sendEsimEmail({
            to: email,
            firstName,
            orderId,
            activationCode: mayaResp?.esim?.activation_code,
            manualCode: mayaResp?.esim?.manual_code,
            smdpAddress: mayaResp?.esim?.smdp_address,
            apn: mayaResp?.esim?.apn,
            planName: item.variant_title,
            iccid: mayaResp?.esim?.iccid,
            country: item.title,
          });
        } catch (e) {
          console.error("❌ Failed to send eSIM email:", e?.message || e);
        }
      } catch (e) {
        shouldMarkProcessed = false;
        console.error("❌ Maya provisioning error:", e.message);
      }
    }
  }

  if (shouldMarkProcessed) {
    try {
      await markOrderProcessed(orderId);
      console.log("✅ Order marked as processed in Shopify:", orderId);
    } catch (e) {
      console.error("❌ Failed to mark order as processed:", e?.message || e);
    }
  } else {
    console.warn("⚠️ Not marking order as processed (some steps failed):", orderId);
  }

  return res.status(200).send("OK");
});

// -----------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));