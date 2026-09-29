import { getServiceAccount, getGoogleAccessToken } from "./src/lib/firebase-admin.server";

async function run() {
  const sa = getServiceAccount();
  const token = await getGoogleAccessToken();
  
  console.log("Testing runAggregationQuery for users...");
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index:runAggregationQuery`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredAggregationQuery: {
        structuredQuery: { from: [{ collectionId: "users_index" }] },
        aggregations: [
          { count: {}, alias: "c" },
          { sum: { field: { fieldPath: "docCount" } }, alias: "d" },
          { sum: { field: { fieldPath: "flashcardCount" } }, alias: "f" }
        ]
      }
    })
  });
  
  if (!resp.ok) {
    console.error("Aggregation failed:", resp.status, await resp.text());
  } else {
    const data = await resp.json();
    console.log("Aggregation success:", JSON.stringify(data, null, 2));
  }

  console.log("Testing top 10 runQuery...");
  const qUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index:runQuery`;
  const qResp = await fetch(qUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "users_index" }],
        orderBy: [{ field: { fieldPath: "docCount" }, direction: "DESCENDING" }],
        limit: 2
      }
    })
  });
  if (!qResp.ok) {
    console.error("Query failed:", qResp.status, await qResp.text());
  } else {
    const qData = await qResp.json();
    console.log("Query success. Docs count:", qData.length);
  }
}

run().catch(console.error);
