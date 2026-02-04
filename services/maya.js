// services/maya.js
import { safeFetch } from "../utils/http.js";

export function mayaAuthHeader() {
  const auth = process.env.MAYA_AUTH;
  if (!auth) throw new Error("Missing MAYA_AUTH env var");
  return `Basic ${auth}`;
}

function mayaBaseUrl() {
  return (process.env.MAYA_BASE_URL || "https://api.maya.net").trim();
}

async function parseJsonSafe(resp) {
  return await resp.json().catch(() => ({}));
}

export async function getMayaCustomerDetails(mayaCustomerId) {
  const resp = await safeFetch(`${mayaBaseUrl()}/connectivity/v1/customer/${mayaCustomerId}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: mayaAuthHeader(),
    },
  });

  const data = await parseJsonSafe(resp);

  if (!resp.ok) {
    console.error("❌ Maya get customer failed:", resp.status, data);
    throw new Error(`Maya get customer failed (${resp.status})`);
  }

  return data;
}

export async function createMayaTopUp({ iccid, planTypeId, tag = "" }) {
  const resp = await safeFetch(
    `${mayaBaseUrl()}/connectivity/v1/esim/${iccid}/plan/${planTypeId}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: mayaAuthHeader(),
      },
      body: JSON.stringify(tag ? { tag } : {}),
    }
  );

  const data = await parseJsonSafe(resp);

  if (!resp.ok) {
    console.error("❌ Maya top-up failed:", resp.status, data);
    throw new Error(`Maya top-up failed (${resp.status})`);
  }

  return data;
}

export async function createMayaCustomer({ email, firstName, lastName, countryIso2, tag = "" }) {
  const body = {
    email,
    first_name: firstName || "",
    last_name: lastName || "",
    country: countryIso2 || "US",
    ...(tag ? { tag } : {}),
  };

  const resp = await safeFetch(`${mayaBaseUrl()}/connectivity/v1/customer/`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: mayaAuthHeader(),
    },
    body: JSON.stringify(body),
  });

  const data = await parseJsonSafe(resp);

  if (!resp.ok) {
    console.error("❌ Maya create customer failed:", resp.status, data);
    throw new Error(`Maya create customer failed (${resp.status})`);
  }

  const customerId = data?.customer?.id || data?.customer?.uid || data?.id || null;
  if (!customerId) {
    console.error("❌ Maya customer created but no id returned:", data);
    throw new Error("Maya customer created but no customer id returned");
  }

  return { raw: data, customerId };
}

export async function createMayaEsim({ planTypeId, customerId, tag = "" }) {
  const body = {
    plan_type_id: planTypeId,
    customer_id: customerId,
    ...(tag ? { tag } : {}),
  };

  const resp = await safeFetch(`${mayaBaseUrl()}/connectivity/v1/esim`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: mayaAuthHeader(),
    },
    body: JSON.stringify(body),
  });

  const data = await parseJsonSafe(resp);

  if (!resp.ok) {
    console.error("❌ Maya create eSIM failed:", resp.status, data);
    throw new Error(`Maya create eSIM failed (${resp.status})`);
  }

  return data;
}
// services/maya.js
import { safeFetch } from "../utils/http.js";

/**
 * Maya auth header.
 * Expect env var MAYA_AUTH to be the base64 credentials WITHOUT the "Basic " prefix.
 * Example (from your curl): Authorization: Basic <BASE64>
 */
export function mayaAuthHeader() {
  const auth = (process.env.MAYA_AUTH || "").trim();
  if (!auth) throw new Error("Missing MAYA_AUTH env var");
  return `Basic ${auth}`;
}

function mayaBaseUrl() {
  // Default to Maya API host; trim trailing slash to avoid double slashes.
  const raw = (process.env.MAYA_BASE_URL || "https://api.maya.net").trim();
  return raw.replace(/\/+$/, "");
}

async function parseJsonSafe(resp) {
  return await resp.json().catch(() => ({}));
}

function throwMayaError_(label, resp, data) {
  const status = resp?.status;
  console.error(`❌ ${label}:`, { status, data });
  throw new Error(`${label} (${status})`);
}

// -----------------------------
// READ: Customer details
// -----------------------------
export async function getMayaCustomerDetails(mayaCustomerId) {
  const resp = await safeFetch(
    `${mayaBaseUrl()}/connectivity/v1/customer/${encodeURIComponent(mayaCustomerId)}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: mayaAuthHeader(),
      },
    }
  );

  const data = await parseJsonSafe(resp);
  if (!resp.ok) throwMayaError_("Maya get customer failed", resp, data);

  return data;
}

// -----------------------------
// READ: eSIM details by ICCID (for usage checks)
// -----------------------------
export async function getMayaEsimDetailsByIccid(iccid) {
  const iccidStr = String(iccid || "").trim();
  if (!iccidStr) throw new Error("getMayaEsimDetailsByIccid: missing iccid");

  const resp = await safeFetch(
    `${mayaBaseUrl()}/connectivity/v1/esim/${encodeURIComponent(iccidStr)}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: mayaAuthHeader(),
      },
    }
  );

  const data = await parseJsonSafe(resp);

  // Maya often returns JSON with {status: 200} even if resp.ok is true; keep both checks.
  if (!resp.ok || (typeof data?.status === "number" && data.status >= 400)) {
    throwMayaError_("Maya get eSIM failed", resp, data);
  }

  return data?.esim || null;
}

// -----------------------------
// WRITE: Top-up
// -----------------------------
export async function createMayaTopUp({ iccid, planTypeId, tag = "" }) {
  const iccidStr = String(iccid || "").trim();
  const planTypeIdStr = String(planTypeId || "").trim();
  if (!iccidStr) throw new Error("createMayaTopUp: missing iccid");
  if (!planTypeIdStr) throw new Error("createMayaTopUp: missing planTypeId");

  const resp = await safeFetch(
    `${mayaBaseUrl()}/connectivity/v1/esim/${encodeURIComponent(iccidStr)}/plan/${encodeURIComponent(
      planTypeIdStr
    )}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: mayaAuthHeader(),
      },
      body: JSON.stringify(tag ? { tag: String(tag) } : {}),
    }
  );

  const data = await parseJsonSafe(resp);
  if (!resp.ok) throwMayaError_("Maya top-up failed", resp, data);

  return data;
}

// -----------------------------
// WRITE: Create customer
// -----------------------------
export async function createMayaCustomer({
  email,
  firstName,
  lastName,
  countryIso2,
  tag = "",
}) {
  const body = {
    email,
    first_name: firstName || "",
    last_name: lastName || "",
    country: countryIso2 || "US",
    ...(tag ? { tag: String(tag) } : {}),
  };

  const resp = await safeFetch(`${mayaBaseUrl()}/connectivity/v1/customer/`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: mayaAuthHeader(),
    },
    body: JSON.stringify(body),
  });

  const data = await parseJsonSafe(resp);
  if (!resp.ok) throwMayaError_("Maya create customer failed", resp, data);

  const customerId = data?.customer?.id || data?.customer?.uid || data?.id || null;
  if (!customerId) {
    console.error("❌ Maya customer created but no id returned:", data);
    throw new Error("Maya customer created but no customer id returned");
  }

  return { raw: data, customerId: String(customerId) };
}

// -----------------------------
// WRITE: Create eSIM
// -----------------------------
export async function createMayaEsim({ planTypeId, customerId, tag = "" }) {
  const planTypeIdStr = String(planTypeId || "").trim();
  const customerIdStr = String(customerId || "").trim();
  if (!planTypeIdStr) throw new Error("createMayaEsim: missing planTypeId");
  if (!customerIdStr) throw new Error("createMayaEsim: missing customerId");

  const body = {
    plan_type_id: planTypeIdStr,
    customer_id: customerIdStr,
    ...(tag ? { tag: String(tag) } : {}),
  };

  const resp = await safeFetch(`${mayaBaseUrl()}/connectivity/v1/esim`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: mayaAuthHeader(),
    },
    body: JSON.stringify(body),
  });

  const data = await parseJsonSafe(resp);
  if (!resp.ok) throwMayaError_("Maya create eSIM failed", resp, data);

  return data;
}