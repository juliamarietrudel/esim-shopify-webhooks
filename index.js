// index.js
import express from "express";
import crypto from "crypto";
import QRCode from "qrcode";
import { Resend } from "resend";
import "dotenv/config";
import fs from "fs";

// import { safeFetch } from "./utils/http.js"; // (unused right now) you can remove

import {
  getVariantConfig,
  getOrderProcessedFlag,
  markOrderProcessed,
  getMayaCustomerIdFromShopifyCustomer,
  saveMayaCustomerIdToShopifyCustomer,
  saveEsimToOrder,
  getOrdersWithEsims,
  usageAlertKey,
  getUsageAlertFlag,
  markUsageAlertSent,
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
const USAGE_ALERT_THRESHOLD_PERCENT = Number(process.env.USAGE_ALERT_THRESHOLD_PERCENT || 75);
// In-memory de-dupe so we don't email every cron run while the server stays up.
// NOTE: if the server restarts, this resets. For true "send once" you should persist a flag in Shopify metafields.

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
  const safeName = (firstName || "").trim() || "client(e)";

  const row = (label, value) =>
    value
      ? `<tr><td style="padding:10px 0;"><b>${label} :</b> ${esc(value)}</td></tr>`
      : "";

  const codeRow = (label, value) =>
    value
      ? `<tr>
          <td style="padding:10px 0;">
            <b>${label} :</b>
            <code style="background:#F1F5F9; padding:4px 8px; border-radius:6px; display:inline-block;">
              ${esc(value)}
            </code>
          </td>
        </tr>`
      : "";

  const apnRow = apn ? `<tr><td style="padding:10px 0;"><b>APN :</b> ${esc(apn)}</td></tr>` : "";

  // ✅ Remplace ces liens par tes URLs réelles
  const links = {
    iphone: "https://quebecesim.ca/pages/installation-esim-iphone",
    samsung: "https://quebecesim.ca/pages/installation-esim-samsung",
    pixel: "https://quebecesim.ca/pages/installation-esim-google-pixel",
    ipad: "https://quebecesim.ca/pages/installation-esim-ipad",
    conso: "https://quebecesim.ca/pages/comment-suivre-ma-consommation",
    erreurs: "https://quebecesim.ca/pages/un-message-derreur-saffiche",
    contact: "https://quebecesim.ca/pages/contactez-nous",
  };

  const bullet = (text) =>
    `<li style="margin:10px 0; line-height:1.45; color:#334155; font-size:14px;">${text}</li>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <title>Votre eSIM est prête</title>
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
                Votre eSIM est prête !
              </h1>

              <p style="font-size: 15px; color:#334155; margin: 0 0 14px;">
                Bonjour <b>${esc(safeName)}</b>,
              </p>

              <p style="font-size: 15px; color:#334155; margin: 0 0 18px;">
                Merci pour votre achat. Vous trouverez ci-dessous les informations nécessaires pour l’installation et l’activation de votre eSIM :
              </p>

              <ul style="margin:0 0 22px 18px; padding:0; color:#334155; font-size:14px;">
                ${bullet("Votre code QR")}
                ${bullet("Votre code d’activation manuel (iPhone et Android)")}
                ${bullet("Les liens vers nos procédures d’installation")}
              </ul>

              <h2 style="font-size: 16px; color:#0F172A; margin: 0 0 12px;">Détails du forfait</h2>

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#FFFFFF; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px; margin-bottom: 22px;">
                ${row("Forfait", planName)}
                ${row("Destination", country)}
                ${row("Validité", validityDays ? `${validityDays} jours` : "")}
                ${row("Données", dataQuotaMb ? `${dataQuotaMb} Mo` : "")}
                ${codeRow("ICCID", iccid)}
              </table>

              <div style="text-align:center; margin: 18px 0 22px;">
                <img 
                    src="${qrDataUrl}"
                    alt="Scanner pour installer l’eSIM"
                    width="180"
                    style="border-radius:12px; border:1px solid #E5E7EB;"
                />
                <p style="font-size:12px; color:#64748B; margin-top:8px;">
                    Scannez ce code QR pour installer votre eSIM
                </p>
              </div>

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#F8FAFC; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px; margin: 12px 0 22px;">
                <tr>
                  <td style="font-size: 13px; color:#475569; line-height:1.45;">
                    <b>Conseil :</b> Si vous utilisez le même téléphone, ouvrez ce courriel sur un autre appareil pour scanner le code QR.
                  </td>
                </tr>
              </table>

              <h2 style="font-size: 16px; color:#0F172A; margin: 0 0 10px;">Recommandations importantes</h2>
              <ul style="margin:0 0 18px 18px; padding:0;">
                ${bullet("Il est préférable d’installer vos eSIM <b>avant votre départ</b>. Les forfaits débutent à la première connexion au réseau de destination. Si votre forfait inclut le Canada, celui-ci débutera le jour de l’installation.")}
                ${bullet("Une connexion <b>Wi-Fi stable</b> est requise lors de l’installation (aucune installation possible sur le Wi-Fi d’un bateau de croisière).")}
                ${bullet("Message d’erreur « eSIM non compatible » : votre appareil est probablement verrouillé par votre fournisseur. Veuillez le contacter pour le déverrouiller.")}
                ${bullet(`Message d’erreur « Impossible d’activer l’eSIM » (iPhone) : votre eSIM est probablement bien installée. Consultez : <a href="${links.erreurs}" style="color:#0CA3EC; text-decoration:none;">Un message d’erreur s’affiche ?</a>`)}
                ${bullet("Avant de monter à bord de votre vol, désactivez votre carte SIM principale et activez votre eSIM à destination.")}
                ${bullet("Assurez-vous que l’itinérance des données est <b>ACTIVÉE</b> pour votre eSIM et que votre mode avion est <b>DÉSACTIVÉ</b>.")}
                ${bullet(`Votre eSIM est rechargeable avec un forfait de la même destination. Surveillez votre consommation : <a href="${links.conso}" style="color:#0CA3EC; text-decoration:none;">Comment suivre ma consommation ?</a>`)}
                ${bullet(`En cas de problème, <b>ne supprimez jamais votre eSIM</b>. Contactez-nous immédiatement : <a href="${links.contact}" style="color:#0CA3EC; text-decoration:none;">Contactez-nous</a>. Aucun remboursement sur une eSIM supprimée sans notre accord.`)}
              </ul>

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#FFFFFF; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px; margin-bottom: 18px;">
                ${codeRow("Code d’activation ANDROID", activationCode)}
                ${codeRow("Code d’activation iPHONE", manualCode)}
                ${codeRow("Adresse SM-DP+", smdpAddress)}
                ${apnRow}
              </table>

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#F8FAFC; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px; margin-bottom: 22px;">
                <tr>
                  <td style="font-size: 13px; color:#475569; line-height:1.45;">
                    <b>RAPPEL :</b> Pour que votre eSIM fonctionne, l’itinérance doit être <b>ACTIVÉE</b> et votre mode avion doit être <b>DÉSACTIVÉ</b>.
                  </td>
                </tr>
              </table>

              <h2 style="font-size: 16px; color:#0F172A; margin: 0 0 10px;">Procédures d’installation</h2>
              <ul style="margin:0 0 8px 18px; padding:0;">
                ${bullet(`<a href="${links.iphone}" style="color:#0CA3EC; text-decoration:none;">Installation d’une eSIM sur iPhone</a>`)}
                ${bullet(`<a href="${links.samsung}" style="color:#0CA3EC; text-decoration:none;">Installation eSIM sur appareil Samsung</a>`)}
                ${bullet(`<a href="${links.pixel}" style="color:#0CA3EC; text-decoration:none;">Installation sur appareil Google Pixel</a>`)}
                ${bullet(`<a href="${links.ipad}" style="color:#0CA3EC; text-decoration:none;">Installation sur iPad (compatible eSIM seulement)</a>`)}
              </ul>

              <p style="font-size: 14px; color:#334155; margin: 18px 0 0;">
                Nous vous souhaitons un excellent voyage avec votre eSIM Québec eSIM !
              </p>

              <p style="font-size: 14px; color:#334155; margin: 6px 0 0;">
                Cordialement,
              </p>

            </td>
          </tr>

          <tr>
            <td style="padding: 18px 24px; background:#F8FAFC; border-top: 1px solid #E5E7EB; font-size: 12px; color:#64748B;">
              <b>Besoin d’aide ?</b>
              <a href="${links.contact}" style="text-decoration:none; color: rgb(94, 94, 94);">
                Contactez-nous
              </a><br/>
              © 2026 Québec eSIM • Propulsé par Maya
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

  const subject = orderId
  ? `Votre eSIM – Code QR (Commande #${orderId})`
  : "Votre eSIM – Code QR";

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

function formatTopUpEmailHtml({ firstName }) {
  const safeName = (firstName || "").trim() || "client(e)";

  return `
    <div style="margin:0; padding:0; background:#F6FAFD; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial; color:#0F172A;">
      <div style="max-width:640px; margin:0 auto; padding:24px;">
        <div style="background:#FFFFFF; border:1px solid #E5E7EB; border-radius:16px; padding:22px;">
          <h2 style="margin:0 0 12px; font-size:18px;">Bonjour ${esc(safeName)} 👋</h2>

          <p style="margin:0 0 12px; font-size:14px; color:#334155;">
            Nous vous confirmons que votre <b>Recharge eSIM</b> a bien été appliquée à votre forfait actuel.
          </p>

          <p style="margin:0 0 12px; font-size:14px; color:#334155;">
            Celle-ci s’activera automatiquement à l’expiration du forfait de départ.
          </p>

          <p style="margin:14px 0 0; font-size:14px; color:#334155;">
            Nous vous souhaitons une excellente fin de séjour !
          </p>

          <p style="margin:14px 0 0; font-size:12px; color:#64748B;">
            Merci,<br/>Québec eSIM
          </p>
        </div>
      </div>
    </div>
  `;
}

async function sendTopUpEmail({ to, firstName, orderId }) {
  if (!emailEnabled) {
    console.log("ℹ️ Skipping top-up email (email not configured).");
    return false;
  }
  if (!to) {
    console.warn("⚠️ No recipient email; cannot send top-up email.");
    return false;
  }

  const subject = orderId
    ? `Recharge eSIM appliquée (Commande #${orderId})`
    : "Recharge eSIM appliquée";

  const html = formatTopUpEmailHtml({ firstName });

  const result = await resend.emails.send({
    from: emailFrom,
    to,
    subject,
    html,
  });

  if (result?.error) {
    console.error("❌ Resend top-up error:", result.error);
    return false;
  }

  console.log("✅ Top-up email sent via Resend:", { to, id: result?.data?.id });
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

async function sendManualActionEmail({
  orderId,
  shopDomain,
  customerEmail,
  customerName,
  variantId,
  mayaPlanId,
  iccid,
  esimUid,
  error,
}) {
  const to = "julia-marie@thewebix.ca";

  // if Resend not configured, at least log it clearly
  if (!emailEnabled) {
    console.warn("⚠️ Manual-action email NOT sent (email not configured).", { orderId, error });
    return false;
  }

  const subject = `⚠️ ACTION REQUISE: eSIM non sauvegardée sur Shopify (Order #${orderId})`;

  const html = `
    <div style="font-family:Arial; font-size:14px; color:#0F172A;">
      <h2>Action manuelle requise</h2>
      <p>La création d'eSIM dans Maya a réussi, mais <b>l’écriture Shopify (esims_json)</b> a échoué.</p>

      <ul>
        <li><b>Order ID</b>: ${esc(orderId)}</li>
        <li><b>Shop</b>: ${esc(shopDomain || "")}</li>
        <li><b>Client</b>: ${esc(customerName || "")} (${esc(customerEmail || "")})</li>
        <li><b>Variant ID</b>: ${esc(variantId || "")}</li>
        <li><b>Maya plan_type_id</b>: ${esc(mayaPlanId || "")}</li>
        <li><b>ICCID</b>: ${esc(iccid || "")}</li>
        <li><b>eSIM UID</b>: ${esc(esimUid || "")}</li>
      </ul>

      <p><b>Erreur:</b></p>
      <pre style="background:#F1F5F9; padding:12px; border-radius:8px; white-space:pre-wrap;">${esc(
        error?.message || String(error || "")
      )}</pre>

      <p><b>À faire:</b> Aller dans Shopify > commande #${esc(orderId)} > métachamps, et coller/ajouter l’eSIM (esims_json / iccid / uid).</p>
    </div>
  `;

  const result = await resend.emails.send({
    from: emailFrom,
    to,
    subject,
    html,
  });

  if (result?.error) {
    console.error("❌ Resend manual-action email error:", result.error);
    return false;
  }

  console.log("✅ Manual-action email sent:", { to, id: result?.data?.id });
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

app.get("/test-email", async (_req, res) => {
  try {
    console.log("🧪 /test-email hit");
    console.log("EMAIL_FROM =", emailFrom ? JSON.stringify(emailFrom) : "(empty)");
    console.log("EMAIL_ENABLED =", emailEnabled);

    if (!emailEnabled || !resend) {
      return res.status(500).send("Email not configured (missing RESEND_API_KEY or EMAIL_FROM)");
    }

    const result = await resend.emails.send({
      from: emailFrom, // must be a verified sender/domain in Resend
      to: "julia-marie@thewebix.ca",
      subject: "Resend test",
      html: "<p>Email works 🎉</p>",
    });

    console.log("📨 Resend result:", result);

    if (result?.error) {
      console.error("❌ Resend error:", result.error);
      return res.status(500).send(`Resend error: ${result.error.message || "unknown"}`);
    }

    return res.send(`Email queued ✅ id=${result?.data?.id || "no-id"}`);
  } catch (err) {
    console.error("❌ /test-email exception:", err);
    return res.status(500).send("Failed to send (exception)");
  }
});

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
      const { orderId, esims, email, firstName } = o;

      console.log(`\n🧾 Order ${orderId} — eSIMs found: ${esims.length}`);

      for (const e of esims) {
        const iccid = e.iccid;

        console.log(`\n🔎 Checking usage for order ${orderId} — ICCID: ${iccid}`);
        console.log("🔎 ABOUT TO FETCH ICCID:", iccid);

        // (optional debug) Maya eSIM details call
        let esim = null;
        try {
          esim = await getMayaEsimDetailsByIccid(iccid);
        } catch (err) {
          console.warn(`⚠️ Maya lookup failed for ICCID ${iccid}:`, err?.message || err);
          continue;
        }
        if (!esim) {
          console.warn(`⚠️ No eSIM found in Maya for ICCID ${iccid}`);
          continue;
        }

        let plans = [];
        try {
          plans = await getMayaEsimPlansByIccid(iccid);
        } catch (err) {
          console.warn(`⚠️ Maya plans lookup failed for ICCID ${iccid}:`, err?.message || err);
          continue;
        }

        console.log("📦 Plans found:", plans.length);

        const activePlan = pickCurrentPlan(plans);

        if (!activePlan) {
          console.warn(`⚠️ No plans attached to ICCID ${iccid}`);
          continue;
        }

        // ✅ Only alert if the plan is activated AND network is ACTIVE/ENABLED
        const activatedRaw = String(activePlan?.date_activated || "");
        const isActivated = activatedRaw && activatedRaw !== "0000-00-00 00:00:00";

        const netRaw = String(activePlan?.network_status || "").toUpperCase();
        const isNetActive = netRaw === "ACTIVE" || netRaw === "ENABLED";

        if (!isActivated || !isNetActive) {
          console.log("ℹ️ Skipping usage alert (plan not active)", {
            iccid,
            planId: activePlan?.id,
            date_activated: activatedRaw,
            network_status: netRaw,
          });
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

        const threshold = Number.isFinite(USAGE_ALERT_THRESHOLD_PERCENT)
          ? USAGE_ALERT_THRESHOLD_PERCENT
          : 20;

        if (Number.isFinite(percentUsed) && percentUsed >= threshold) {
          const key = usageAlertKey(threshold, iccid);

          let flag = { sent: false };
          try {
            flag = await getUsageAlertFlag(orderId, key);
          } catch (err) {
            console.error("❌ Could not read usage alert flag:", err?.message || err);
          }

          if (flag.sent) {
            console.log(`ℹ️ Usage alert already sent for ${orderId}:${key}, skipping.`);
          } else {
            if (!email) {
              console.warn(`⚠️ Usage alert triggered (${percentUsed}%) but order is missing email. Order ${orderId}`);
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

                await markUsageAlertSent(orderId, key);
                console.log(`✅ Marked usage alert as sent on Shopify for ${orderId}:${key}`);
              } catch (err) {
                console.error("❌ Failed to send/mark usage alert email:", err?.message || err);
              }
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
  console.log("Buffer rawBody?", Buffer.isBuffer(req.rawBody));
  console.log("Raw body length:", req.rawBody?.length);
  console.log("HMAC MATCH:", ok);
  console.log("---- WEBHOOK DEBUG END ----");

  if (!ok) return res.status(401).send("Invalid signature");


  fs.writeFileSync("last-webhook.json", req.rawBody);
  console.log("✅ Saved last webhook payload to last-webhook.json");

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
        tag: String(orderId)
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

      // ✅ Send confirmation email for top-up (once per order)
      try {
        await sendTopUpEmail({ to: email, firstName, orderId });
      } catch (e) {
        console.error("❌ Failed to send top-up email:", e?.message || e);
      }

      continue;
    }

    // -----------------------------
    // NORMAL eSIM purchase: create eSIM(s)
    // -----------------------------
    for (let q = 0; q < qty; q++) {
      try {

          const baseTag = `${item.title}-${item.variant_title}`
          .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove accents
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");

        const esimTag = qty > 1 ? `${baseTag}-${q + 1}` : baseTag;

        const mayaResp = await createMayaEsim({
          planTypeId: mayaPlanId,
          customerId: mayaCustomerId,
          tag: esimTag,
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
          console.warn("🚨 MANUAL ACTION REQUIRED — Shopify save failed for order", orderId);
          shouldMarkProcessed = false;
          try {
          await sendManualActionEmail({
            orderId,
            shopDomain: req.get("X-Shopify-Shop-Domain"),
            customerEmail: email,
            customerName: `${firstName || ""} ${lastName || ""}`.trim(),
            variantId,
            mayaPlanId,
            iccid: mayaResp?.esim?.iccid,
            esimUid: mayaResp?.esim?.uid,
            error: e,
          });
        } catch (mailErr) {
          console.error("❌ Failed to send manual-action email:", mailErr?.message || mailErr);
        }

        // IMPORTANT: don't mark processed so it doesn't get "completed" silently
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