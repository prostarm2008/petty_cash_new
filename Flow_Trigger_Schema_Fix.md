# Fixing the Power Automate trigger schema

## The recommended fix — 2 minutes, permanent

Three write failures in a row have all come from the same place: the trigger schema on the
UPDATE / ADD record Flow. It was auto-generated from one sample payload, so it now demands
that every future payload match that sample exactly — same types, same keys, nothing missing.

| Attempt | Flow rejected with |
|---|---|
| 1 | `Expected Array but got String` — arrays sent as JSON text |
| 2 | `Expected Integer but got String` — `year` returned from Excel as text |
| 3 | `Required properties are missing from object: data` — the base64 key removed |

Each is fixed in the app. But the schema will keep breaking every time a column is added,
and it fails the **whole** write — there is no partial save.

**In the Flow:**

1. Open the **When an HTTP request is received** trigger.
2. Clear the **Request Body JSON Schema** box completely, or replace it with `{}`.
3. Save.

The trigger then accepts any JSON body. Downstream actions still reference fields by name
exactly as they do now, so nothing else in the Flow changes.

If you would rather keep a schema, use **Use sample payload to generate schema** and paste a
current payload — then remove the `"required": [...]` arrays it generates, which are what
produce the "Required properties are missing" failures.

---

## What the app now sends

| Field | Type | Note |
|---|---|---|
| `supportingDocs` | **Array** of objects | Every key preserved, including `data` — sent **empty** |
| `auditTrail` | **Array** of objects | Every key preserved |
| `year`, `expenseAmount`, `receivedAmount` | **Number** | Re-coerced on read and write |
| `docCount`, `auditCycleCount`, `reqOriginalAmount` | **Number** | |
| everything else | **String** | Capped at 30,000 characters |

No key is ever dropped. Null becomes `""` rather than disappearing, because a missing key fails
a generated schema exactly like a wrong type does.

## If a fourth mismatch appears

The toast now quotes the Flow verbatim, so it will name the field. Two switches at the top of
the script in `dashboard.html` cover the likely cases:

```js
const SEND_EXTRA_DOC_COLUMNS = true;   // set false if docCount / docNames are rejected
const NUMERIC_FIELDS = [...];          // add any other Integer column the schema declares
```

## Why `data` is sent empty

A 200 KB attachment is about 273,000 characters of base64. An Excel cell holds 32,767 — so the
bytes cannot go in the sheet at any size worth uploading. The key is kept so the schema is
satisfied; the value is blank.

Files therefore remain viewable on the machine that uploaded them. Other users see the name,
uploader and timestamp. To make them viewable everywhere, upload to a SharePoint library and
write the returned link into each document's `url` field — the app already prefers `url` over
local bytes wherever a document is rendered.