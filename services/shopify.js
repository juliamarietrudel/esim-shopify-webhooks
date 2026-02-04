// services/shopify.js
import { safeFetch } from "../utils/http.js";

export function shopifyGraphqlUrl() {
  const shopRaw = process.env.SHOPIFY_SHOP_DOMAIN;
  const versionRaw = process.env.SHOPIFY_API_VERSION || "2025-01";

  const shop = (shopRaw || "").trim();
  const version = (versionRaw || "").trim();

  if (!shop) throw new Error("Missing SHOPIFY_SHOP_DOMAIN env var");
  if (!version) throw new Error("Missing SHOPIFY_API_VERSION env var");

  return `https://${shop}/admin/api/${version}/graphql.json`;
}

export async function shopifyGraphql(query, variables = {}) {
  const url = shopifyGraphqlUrl();
  const token = shopifyToken();

  const resp = await safeFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await parseJsonSafe(resp);

  if (!resp.ok || json?.errors) {
    console.error("❌ Shopify GraphQL error:", json.errors || json);
    throw new Error(`Shopify GraphQL failed (${resp.status})`);
  }

  return json;
}

function shopifyToken() {
  const token = process.env.API_ACCESS_TOKEN;
  if (!token) throw new Error("Missing API_ACCESS_TOKEN env var");
  return token;
}

async function parseJsonSafe(resp) {
  return await resp.json().catch(() => ({}));
}

// ---------- Variant config ----------
export async function getVariantConfig(variantId) {
  const url = shopifyGraphqlUrl();
  const token = shopifyToken();

  const gid = `gid://shopify/ProductVariant/${variantId}`;

  const query = `
    query ($id: ID!) {
      productVariant(id: $id) {
        id
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

  const json = await parseJsonSafe(resp);

  if (!resp.ok || json.errors) {
    console.error("❌ Shopify GraphQL error:", json.errors || json);
    throw new Error(`Shopify GraphQL failed (${resp.status})`);
  }

  const v = json?.data?.productVariant;
  const mayaPlanId = (v?.mayaPlanId?.value || "").trim() || null;
  const productType = (v?.productType?.value || "").trim().toLowerCase() || null;

  return { mayaPlanId, productType };
}

// ---------- Customer Maya ID metafield ----------
export async function getMayaCustomerIdFromShopifyCustomer(shopifyCustomerId) {
  const url = shopifyGraphqlUrl();
  const token = shopifyToken();

  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;

  const query = `
    query ($id: ID!) {
      customer(id: $id) {
        metafield(namespace: "custom", key: "maya_customer_id") { value }
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

  const json = await parseJsonSafe(resp);

  if (!resp.ok || json.errors) {
    console.error("❌ Shopify customer metafield read error:", json.errors || json);
    throw new Error(`Shopify GraphQL failed (${resp.status})`);
  }

  return json?.data?.customer?.metafield?.value || null;
}

export async function saveMayaCustomerIdToShopifyCustomer(shopifyCustomerId, mayaCustomerId) {
  const url = shopifyGraphqlUrl();
  const token = shopifyToken();

  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
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

  const json = await parseJsonSafe(resp);

  const userErrors = json?.data?.metafieldsSet?.userErrors || [];
  if (!resp.ok || json.errors || userErrors.length) {
    console.error("❌ Shopify metafield write error:", { status: resp.status, json, userErrors });
    throw new Error(userErrors[0]?.message || "Failed to write Shopify customer metafield");
  }

  return true;
}

// --- IDEMPOTENCY SUR ORDER (tes fonctions, je les garde) ---
export async function getOrderProcessedFlag(orderId) {
  const url = shopifyGraphqlUrl();
  const token = shopifyToken();

  const gid = `gid://shopify/Order/${orderId}`;

  const query = `
    query ($id: ID!) {
      order(id: $id) {
        processed: metafield(namespace: "custom", key: "maya_processed") { value }
        processedAt: metafield(namespace: "custom", key: "maya_processed_at") { value }
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

  const json = await parseJsonSafe(resp);

  const processed =
    String(json?.data?.order?.processed?.value || "").trim().toLowerCase() === "true";

  return {
    processed,
    processedAt: json?.data?.order?.processedAt?.value || null,
  };
}

export async function markOrderProcessed(orderId) {
  const url = shopifyGraphqlUrl();
  const token = shopifyToken();

  const gid = `gid://shopify/Order/${orderId}`;
  const nowIso = new Date().toISOString();

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: gid,
        namespace: "custom",
        key: "maya_processed",
        type: "single_line_text_field",
        value: "true",
      },
      {
        ownerId: gid,
        namespace: "custom",
        key: "maya_processed_at",
        type: "single_line_text_field",
        value: nowIso,
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

  const json = await parseJsonSafe(resp);
  if (!resp.ok || json.errors) {
    console.error("❌ Shopify markOrderProcessed error:", json.errors || json);
    throw new Error(`Shopify GraphQL failed (${resp.status})`);
  }

  return true;
}

// ---------- Order eSIM details metafields (for usage tracking) ----------
export async function saveEsimToOrder(orderId, { iccid, esimUid } = {}) {
  if (!orderId) throw new Error("saveEsimToOrder: missing orderId");

  const gid = `gid://shopify/Order/${orderId}`;

  const metafields = [];

  if (iccid) {
    metafields.push({
      ownerId: gid,
      namespace: "custom",
      key: "maya_iccid",
      type: "single_line_text_field",
      value: String(iccid),
    });
  }

  if (esimUid) {
    metafields.push({
      ownerId: gid,
      namespace: "custom",
      key: "maya_esim_uid",
      type: "single_line_text_field",
      value: String(esimUid),
    });
  }

  if (!metafields.length) return true;

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const variables = { metafields };

  const json = await shopifyGraphql(mutation, variables);

  const userErrors = json?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) {
    console.error("❌ Shopify saveEsimToOrder userErrors:", { orderId, userErrors });
    throw new Error(userErrors[0]?.message || "Failed to write Shopify order metafields");
  }

  return true;
}

// ---------- Find orders that have eSIMs saved (maya_iccid) ----------
export async function getOrdersWithEsims({ daysBack = 120 } = {}) {
  const sinceDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10); // YYYY-MM-DD

  const searchQuery = `created_at:>='${sinceDate}' metafield:custom.maya_iccid`;

  const query = `
    query OrdersWithEsims($first: Int!, $query: String!) {
      orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            email
            customer {
              firstName
              lastName
            }
            billingAddress {
              firstName
              lastName
            }
            shippingAddress {
              firstName
              lastName
            }
            mayaIccid: metafield(namespace: "custom", key: "maya_iccid") { value }
            mayaEsimUid: metafield(namespace: "custom", key: "maya_esim_uid") { value }
          }
        }
      }
    }
  `;

  const json = await shopifyGraphql(query, { first: 100, query: searchQuery });

  const edges = json?.data?.orders?.edges || [];

  return edges
    .map(({ node }) => {
      const orderGid = node?.id || "";
      const orderId = orderGid.split("/").pop(); // gid://shopify/Order/123 -> "123"

      const email = (node?.email || "").trim() || "";

      const firstName =
        (node?.customer?.firstName || "").trim() ||
        (node?.billingAddress?.firstName || "").trim() ||
        (node?.shippingAddress?.firstName || "").trim() ||
        "";

      const lastName =
        (node?.customer?.lastName || "").trim() ||
        (node?.billingAddress?.lastName || "").trim() ||
        (node?.shippingAddress?.lastName || "").trim() ||
        "";

      const iccid = (node?.mayaIccid?.value || "").trim();
      const esimUid = (node?.mayaEsimUid?.value || "").trim();

      if (!orderId || !iccid) return null;

      return { orderId, email, firstName, lastName, iccid, esimUid };
    })
    .filter(Boolean);
}